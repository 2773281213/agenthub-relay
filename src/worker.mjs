// The worker that carries one job from queued to a final status. It runs as
// a detached process (`agenthub-relay worker <id>`) so jobs outlive the MCP
// server and the planner's session; it can also run in-process for tests.
//
// queued -> running (executor) -> verifying (checks, change audit)
//        -> completed | failed | cancelled

import fs from 'node:fs';
import path from 'node:path';

import { notRun, runChecks, runProcess, verdict } from './checks.mjs';
import { loadConfig } from './config.mjs';
import { adapterFor, buildPrompt, childEnv } from './executors.mjs';
import { collectChanges } from './git.mjs';
import { outOfScope } from './policy.mjs';
import { createStore, HEARTBEAT_MS, TERMINAL } from './store.mjs';

const MAX_SUMMARY_CHARS = 20_000;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

const now = () => new Date().toISOString();

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function clip(text, max = MAX_SUMMARY_CHARS) {
  return text.length > max ? `${text.slice(0, max)}\n[…truncated; full text in final.md]` : text;
}

/**
 * Runs a queued job to its end and resolves with the final record.
 *
 * @param {object} options
 * @param {string} options.root the repository root
 * @param {string} options.jobId the job to run
 * @param {object} [options.env] the environment executors are filtered from
 * @param {AbortSignal} [options.signal] aborts the job (relay_cancel)
 */
export async function runWorker({ root, jobId, env = process.env, signal: external } = {}) {
  const store = createStore(root);
  const files = store.paths(jobId);
  let job = await store.update(jobId, draft => {
    if (draft.status !== 'queued') throw fail('job-not-queued', `Job ${jobId} is ${draft.status}, not queued`);
    draft.worker = { pid: process.pid };
    if (draft.cancelRequested) {
      draft.status = 'cancelled';
      draft.endedAt = now();
      draft.error = { code: 'cancelled', message: 'The job was cancelled before it started.' };
      return;
    }
    draft.status = 'running';
    draft.startedAt = now();
    draft.heartbeatAt = now();
  });
  if (job.status === 'cancelled') return job;

  // A cancel arrives as SIGTERM (the CLI turns it into `external`) or, if the
  // signal is lost, as the record's cancelRequested flag seen at a heartbeat.
  const controller = new AbortController();
  const signal = controller.signal;
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', () => controller.abort(), { once: true });
  const heartbeat = setInterval(() => {
    store
      .update(jobId, draft => {
        if (!TERMINAL.has(draft.status)) draft.heartbeatAt = now();
        if (draft.cancelRequested) controller.abort();
      })
      .catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const finish = async (mutate, event) => {
    clearInterval(heartbeat);
    const final = await store.update(jobId, draft => {
      mutate(draft);
      draft.endedAt = now();
    });
    if (event) store.appendEvent(jobId, event);
    return final;
  };

  try {
    const config = loadConfig({ root, env });
    const adapter = adapterFor(job.executor);
    const executorConfig = config.executors[job.executor];
    const worktree = path.join(root, job.worktree);
    const { env: executorEnv, passed } = childEnv(env, executorConfig, jobId);
    const invocation = adapter.invocation(job, executorConfig, files, buildPrompt(job));

    await store.update(jobId, draft => {
      draft.passedEnv = passed; // names only
    });
    store.appendEvent(jobId, { type: 'executor-started', executor: job.executor });
    const run = await runProcess({
      argv: invocation.argv,
      cwd: worktree,
      env: executorEnv,
      stdin: invocation.stdin,
      timeoutMs: job.timeoutMinutes * 60_000,
      logFile: files.executorLog,
      signal,
    });

    const finalText = readIfExists(files.final);
    const parsed = run.spawnError
      ? { ok: false, summary: '', error: `Could not start ${invocation.argv[0]}: ${run.spawnError.code ?? run.spawnError.message}` }
      : adapter.parse({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, finalText });
    if (!finalText && parsed.summary) fs.writeFileSync(files.final, `${parsed.summary}\n`);
    const executorOk = parsed.ok && !run.timedOut && !run.cancelled;
    const executorRun = {
      exitCode: run.exitCode,
      signal: run.signal ?? undefined,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      ok: executorOk,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      costUsd: parsed.costUsd,
      error: run.timedOut ? `The executor timed out after ${job.timeoutMinutes} min` : parsed.error,
    };
    store.appendEvent(jobId, { type: 'executor-finished', ok: executorOk, exitCode: run.exitCode, timedOut: run.timedOut });

    let checks;
    let cancelled = run.cancelled;
    if (!cancelled) {
      await store.update(jobId, draft => {
        draft.status = 'verifying';
        draft.executorRun = executorRun;
        draft.summary = clip(parsed.summary);
      });
      checks = executorOk
        ? await runChecks(job.checks, {
            cwd: worktree,
            env: executorEnv,
            timeoutMs: config.checks.timeoutMinutes * 60_000,
            logDir: files.checksDir,
            signal,
          })
        : notRun(job.checks, 'not run: the executor did not finish successfully');
      cancelled = signal?.aborted === true;
    } else {
      checks = notRun(job.checks, 'not run: the job was cancelled');
    }

    // The audit runs whatever happened, so the planner sees what was touched.
    const changes = await collectChanges(worktree, job.base.commit);
    fs.writeFileSync(files.patch, changes.patch);
    const strays = job.write ? outOfScope(changes.files, job.scope) : changes.files;
    const warnings = [...(job.warnings ?? [])];
    if (job.tier === 'light' && changes.files.length > config.light.maxChangedFiles) {
      warnings.push(`A light job changed ${changes.files.length} files (more than ${config.light.maxChangedFiles}).`);
    }
    if (!job.write && changes.files.length > 0) {
      warnings.push('A read-only review changed files; they are all reported as out of scope.');
    }

    const outcome = cancelled ? { status: 'cancelled', verification: checks.length ? 'not-run' : 'unverified' } : verdict({ executorOk, checks });
    return await finish(
      draft => {
        draft.status = outcome.status;
        draft.verification = outcome.verification;
        draft.executorRun = executorRun;
        draft.summary = clip(parsed.summary);
        draft.checkResults = checks;
        draft.changedFiles = changes.files;
        draft.outOfScope = strays;
        draft.patchStat = changes.stat;
        draft.warnings = warnings;
        if (outcome.status === 'failed') {
          draft.error = executorOk
            ? { code: 'checks-failed', message: 'At least one check failed.' }
            : { code: run.timedOut ? 'executor-timeout' : 'executor-failed', message: executorRun.error ?? 'The executor failed.' };
        }
        if (outcome.status === 'cancelled') draft.error = { code: 'cancelled', message: 'The job was cancelled.' };
      },
      { type: 'finished', status: outcome.status, verification: outcome.verification, changed: changes.files.length, outOfScope: strays.length },
    );
  } catch (err) {
    return finish(
      draft => {
        if (!TERMINAL.has(draft.status)) draft.status = 'failed';
        draft.error = { code: err.code ?? 'worker-error', message: err.message };
      },
      { type: 'finished', status: 'failed', error: err.code ?? 'worker-error' },
    );
  }
}
