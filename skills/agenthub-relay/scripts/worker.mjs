// The worker that carries one turn of a job from queued to a final status. It
// runs as a detached process (`agenthub-relay worker <id>`) so jobs outlive
// the MCP server and the planner's session; it can also run in-process for
// tests.
//
// queued -> running (executor) -> verifying (checks, change audit)
//        -> completed | failed | cancelled
//
// The job's latest turn says what to run: a dispatch turn starts the
// executor's session, a send turn continues it (`resume`), and a collect turn
// (a person handing a taken-over job back) skips the executor and goes from
// queued straight to verifying. Every turn's log, final message and check
// logs live under turns/<n>/; the patch is always the whole change since the
// job's baseline.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { notRun, redactText, runChecks, runProcess, verdict } from './checks.mjs';
import { loadConfig } from './config.mjs';
import { locateExecutor } from './discovery.mjs';
import {
  adapterFor, buildFollowUpPrompt, buildPrompt, childEnv, dshCapabilities, normalizeUsage, SESSION_ID, spawnArgv, turnUsage,
} from './executors.mjs';
import { CODEXHOST_ENV, envFor } from './codexhost.mjs';
import { checkBranch, collectChanges } from './git.mjs';
import { renameWithRetry } from './platform.mjs';
import { outOfScope } from './policy.mjs';
import { createStore, HEARTBEAT_MS, TERMINAL } from './store.mjs';

const MAX_SUMMARY_CHARS = 20_000;
/** How much of a turn's summary its entry in `turns` keeps; the whole is in turns/<n>/final.md. */
const MAX_TURN_SUMMARY_CHARS = 2_000;
/** How often the worker reads the cancel flag (relay_cancel on Windows sends no signal). */
export const CANCEL_POLL_MS = 1_000;

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
  const value = typeof text === 'string' ? text : '';
  return value.length > max ? `${value.slice(0, max)}\n[…truncated; full text in final.md]` : value;
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // not there
  }
}

/** A driven run's report with credential values passed by name replaced by [redacted]. */
function redactParsed(parsed, redact) {
  if (!redact.length) return parsed;
  const clean = value => (typeof value === 'string' ? redactText(value, redact) : value);
  return {
    ...parsed,
    summary: clean(parsed.summary),
    error: clean(parsed.error),
    ...(parsed.needsInput
      ? { needsInput: { questions: parsed.needsInput.questions.map(q => ({ ...q, text: clean(q.text), ...(q.options ? { options: q.options.map(clean) } : {}) })) } }
      : {}),
  };
}

/** Warnings that belong to the dispatch, not to one turn's audit. */
function baseWarningsOf(job) {
  return job.baseWarnings ?? job.warnings ?? [];
}

/**
 * Runs the job's queued turn to its end and resolves with the final record.
 *
 * @param {object} options
 * @param {string} options.root the repository root
 * @param {string} options.jobId the job to run
 * @param {object} [options.env] the environment executors are filtered from
 * @param {AbortSignal} [options.signal] aborts the job (relay_cancel)
 * @param {string} [options.platform] process.platform
 */
export async function runWorker({ root, jobId, env = process.env, signal: external, platform = process.platform } = {}) {
  const store = createStore(root);
  const files = store.paths(jobId);
  let job = await store.update(jobId, draft => {
    if (draft.status !== 'queued') throw fail('job-not-queued', `Job ${jobId} is ${draft.status}, not queued`);
    draft.worker = { pid: process.pid };
    if (!Array.isArray(draft.turns) || draft.turns.length === 0) {
      draft.turns = [{ n: 1, kind: 'dispatch', by: 'planner', queuedAt: draft.createdAt }];
    }
    const turn = draft.turns.at(-1);
    if (draft.cancelRequested) {
      draft.status = 'cancelled';
      draft.endedAt = now();
      draft.error = { code: 'cancelled', message: 'The job was cancelled before it started.' };
      Object.assign(turn, { status: 'cancelled', endedAt: draft.endedAt, error: 'cancelled' });
      return;
    }
    draft.status = turn.kind === 'collect' ? 'verifying' : 'running';
    draft.startedAt = now();
    draft.heartbeatAt = now();
    Object.assign(turn, { status: draft.status, startedAt: draft.startedAt });
  });
  if (job.status === 'cancelled') return job;
  const turn = job.turns.at(-1);
  const turnFiles = files.turn(turn.n);
  fs.mkdirSync(turnFiles.checksDir, { recursive: true });
  // The top-level final.md is the latest turn's; until this one writes its own
  // there is none, so a turn that fails early cannot pass for the last one.
  removeFile(files.final);

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
  const cancelPoll = setInterval(() => {
    try {
      if (store.read(jobId).cancelRequested) controller.abort();
    } catch {
      // a read racing a write: the next poll sees it
    }
  }, CANCEL_POLL_MS);
  cancelPoll.unref?.();

  const finish = async (mutate, event) => {
    clearInterval(heartbeat);
    clearInterval(cancelPoll);
    const final = await store.update(jobId, draft => {
      mutate(draft);
      draft.endedAt = now();
      const entry = draft.turns.at(-1);
      Object.assign(entry, {
        status: draft.status,
        endedAt: draft.endedAt,
        ...(draft.verification ? { verification: draft.verification } : {}),
        ...(draft.error ? { error: draft.error.code } : {}),
      });
    });
    if (event) store.appendEvent(jobId, { ...event, turn: turn.n });
    return final;
  };

  // What this turn has got so far: kept on record even when a later step fails.
  let parsed = { ok: true, summary: '' };
  let executorRun;
  let executorOk = true;
  let checks;
  /** The turn's own usage on its entry in `turns`. */
  const recordUsage = draft => {
    if (!executorRun) return;
    const entry = draft.turns.at(-1);
    entry.durationMs = executorRun.durationMs;
    const own = turnUsage(job.executor, executorRun.normalizedUsage, draft.turns.slice(0, -1), { resumed: turn.kind !== 'dispatch' });
    if (own.usage && Object.keys(own.usage).length) entry.usage = own.usage;
    if (own.sessionUsage) entry.sessionUsage = own.sessionUsage;
  };
  // The latest turn's final message is also the job's; it is in place before
  // the job is recorded as ended, and never seen half written.
  const publishFinal = () => {
    const latest = readIfExists(turnFiles.final);
    if (latest) writeFileAtomic(files.final, latest);
  };

  try {
    const config = loadConfig({ root, env });
    const adapter = adapterFor(job.executor);
    const executorConfig = config.executors[job.executor];
    const worktree = path.join(root, job.worktree);
    const { env: executorEnv, passed } = childEnv(env, executorConfig, jobId);
    // Values of the credentials passed by name: held in memory only, and
    // replaced by [redacted] wherever executor or check output is kept.
    const redact = passed.map(name => executorEnv[name]);

    let cancelled = false;
    let timedOut = false;
    if (turn.kind !== 'collect') {
      const located = locateExecutor(job.executor, executorConfig.command, { env, platform });
      const cfg = { ...executorConfig, command: located.command };
      const caps = { platform, ...(job.executor === 'dsh' ? dshCapabilities(cfg.command, { env: executorEnv, platform }) : {}) };
      const runFiles = { final: turnFiles.final };
      if (turn.kind === 'send' && !job.native?.sessionId) throw fail('resume-unsupported', `Job ${jobId} has no ${job.executor} session to continue`);
      let invocation;
      if (adapter.drive) {
        // driven below
      } else if (turn.kind === 'send') {
        invocation = adapter.resume(job, cfg, runFiles, buildFollowUpPrompt(job, turn), job.native.sessionId, caps);
      } else {
        invocation = adapter.invocation(job, cfg, runFiles, buildPrompt(job), caps);
      }

      await store.update(jobId, draft => {
        draft.passedEnv = passed; // names only
        if (located.discovered) draft.executorPath = located.command;
      });
      store.appendEvent(jobId, { type: 'executor-started', executor: job.executor, turn: turn.n, kind: turn.kind });
      // A session id is saved the moment the executor prints it, so a worker
      // that is lost mid-run (a reboot, a crash) still leaves a session to continue.
      let seenSession = job.native?.sessionId;
      let saving = Promise.resolve();
      const saveSession = id => {
        if (!id || id === seenSession || !SESSION_ID.test(id)) return saving;
        seenSession = id;
        saving = saving
          .then(() => store.update(jobId, draft => {
            draft.native = { ...(draft.native ?? {}), sessionId: id };
          }))
          .catch(() => {});
        return saving;
      };
      let run;
      if (adapter.drive) {
        const driveEnv = envFor(executorEnv, env);
        const driven = await adapter.drive({
          job,
          cfg,
          prompt: turn.kind === 'send' ? buildFollowUpPrompt(job, turn) : buildPrompt(job),
          sessionId: turn.kind === 'send' ? job.native.sessionId : undefined,
          // An answer to a question has to stop the turn that asked it.
          interrupt: turn.kind === 'send' && (turn.interrupted === true || turn.answers === true),
          cwd: worktree,
          env: driveEnv,
          signal,
          timeoutMs: job.timeoutMinutes * 60_000,
          logFile: turnFiles.executorLog,
          redact: [...redact, ...CODEXHOST_ENV.filter(name => /TOKEN$/.test(name)).map(name => driveEnv[name]).filter(Boolean)],
          platform,
          onSession: saveSession,
        });
        run = driven.run;
        parsed = redactParsed({ ...driven.parsed, summary: driven.parsed.summary ?? '' }, redact);
      } else {
        const launch = spawnArgv(invocation.argv, { env: executorEnv, platform });
        run = await runProcess({
          argv: launch.argv,
          cwd: worktree,
          env: { ...executorEnv, ...launch.env, ...(invocation.env ?? {}) },
          stdin: invocation.stdin,
          timeoutMs: job.timeoutMinutes * 60_000,
          logFile: turnFiles.executorLog,
          signal,
          redact,
          platform,
          onStdoutLine: line => {
            saveSession(adapter.sessionFromLine(line));
          },
        });
      }
      await saving;

      // An executor may write its final message itself (codex -o): scrub it too.
      const written = readIfExists(turnFiles.final);
      const finalText = redactText(written, redact);
      if (finalText !== written) fs.writeFileSync(turnFiles.final, finalText);
      if (!adapter.drive) {
        parsed = run.spawnError
          ? { ok: false, summary: '', error: `Could not start ${invocation.argv[0]}: ${run.spawnError.code ?? run.spawnError.message}` }
          : adapter.parse({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, finalText, caps });
      }
      if (!finalText && parsed.summary) fs.writeFileSync(turnFiles.final, `${parsed.summary}\n`);
      timedOut = run.timedOut;
      cancelled = run.cancelled;
      executorOk = parsed.ok && !run.timedOut && !run.cancelled;
      let sessionId = parsed.sessionId && SESSION_ID.test(parsed.sessionId) ? parsed.sessionId : seenSession;
      // Claude Code is given its session id before it starts. A first turn that
      // never got going (it could not start, or quit at once with nothing on
      // stdout) left no session under that id; one that was stopped or timed
      // out did, and keeps it for a takeover or a follow-up.
      const neverStarted = run.spawnError
        || (!parsed.sessionId && run.exitCode !== 0 && !run.cancelled && !run.timedOut && String(run.stdout ?? '').trim() === '');
      if (adapter.presetSession && turn.kind === 'dispatch' && neverStarted) {
        sessionId = undefined;
        await store.update(jobId, draft => {
          if (draft.native) delete draft.native.sessionId;
        });
      }
      executorRun = {
        exitCode: run.exitCode,
        signal: run.signal ?? undefined,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        ok: executorOk,
        sessionId,
        usage: parsed.usage,
        normalizedUsage: normalizeUsage(job.executor, parsed),
        costUsd: parsed.costUsd,
        error: run.timedOut ? `The executor timed out after ${job.timeoutMinutes} min` : parsed.error,
        ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      };
      if (sessionId && sessionId !== job.native?.sessionId) {
        await store.update(jobId, draft => {
          draft.native = { ...(draft.native ?? {}), sessionId };
        });
      }
      store.appendEvent(jobId, { type: 'executor-finished', ok: executorOk, exitCode: run.exitCode, timedOut: run.timedOut, turn: turn.n });
    }

    // A worktree moved to another branch or rewritten past its baseline would
    // turn into a patch of unrelated history: refuse to collect it.
    const diverged = branch =>
      finish(
        draft => {
          draft.status = cancelled ? 'cancelled' : 'failed';
          // The checks may have run (the branch moved while they did): say what
          // they found; the patch is what was not collected.
          draft.verification = checks.length === 0
            ? 'unverified'
            : checks.every(check => check.status === 'not-run') ? 'not-run' : verdict({ executorOk, checks }).verification;
          draft.executorRun = executorRun;
          draft.summary = clip(parsed.summary);
          draft.checkResults = checks;
          draft.warnings = [...baseWarningsOf(draft), ...(parsed.warnings ?? []), `Changes were not collected: ${branch.reason}. The patch on record is from an earlier turn.`];
          draft.error = { code: 'branch-diverged', message: `The job's worktree no longer matches its branch: ${branch.reason}.` };
          draft.turns.at(-1).summary = clip(parsed.summary, MAX_TURN_SUMMARY_CHARS);
          recordUsage(draft);
        },
        { type: 'finished', status: cancelled ? 'cancelled' : 'failed', error: 'branch-diverged' },
      );

    if (!cancelled) {
      // Checked before the checks too: a worktree that left its branch (a
      // takeover that switched or rebased it) fails at once, not after them.
      const before = await checkBranch(worktree, job.branch, job.base.commit);
      if (!before.ok) {
        checks = notRun(job.checks, "not run: the worktree left the job's branch");
        publishFinal();
        return await diverged(before);
      }
      await store.update(jobId, draft => {
        if (draft.status !== 'verifying') draft.status = 'verifying';
        draft.executorRun = executorRun;
        draft.summary = clip(parsed.summary);
      });
      checks = executorOk
        ? await runChecks(job.checks, {
            cwd: worktree,
            env: executorEnv,
            timeoutMs: config.checks.timeoutMinutes * 60_000,
            logDir: turnFiles.checksDir,
            signal,
            redact,
            shell: config.checks.shell,
            platform,
          })
        : notRun(job.checks, 'not run: the executor did not finish successfully');
      cancelled = signal.aborted === true;
    } else {
      checks = notRun(job.checks, 'not run: the job was cancelled');
    }

    // Again right before the patch is collected: the checks ran in the worktree.
    const branch = await checkBranch(worktree, job.branch, job.base.commit);
    if (!branch.ok) {
      publishFinal();
      return await diverged(branch);
    }

    // The audit runs whatever happened, so the planner sees what was touched.
    const changes = await collectChanges(worktree, job.base.commit, { indexDir: files.dir });
    const patch = redactText(changes.patch, redact);
    writeFileAtomic(files.patch, patch);
    const strays = job.write ? outOfScope(changes.files, job.scope) : changes.files;
    // What the executor's driver reported beyond the outcome (codexhost: a
    // turn that may still run in the Host).
    const audit = [...(parsed.warnings ?? [])];
    if (patch !== changes.patch) {
      audit.push(
        'The executor wrote the value of a credential passed by name into its changes. The stored patch has [redacted] in its place, so applying it writes [redacted]; review those files.',
      );
    }
    if (job.tier === 'light' && changes.files.length > config.light.maxChangedFiles) {
      audit.push(`A light job changed ${changes.files.length} files (more than ${config.light.maxChangedFiles}).`);
    }
    if (!job.write && changes.files.length > 0) {
      audit.push('A read-only review changed files; they are all reported as out of scope.');
    }
    if (turn.kind === 'collect' && !job.write && changes.files.length > 0) {
      audit.push('This review was taken over, so its read-only rule no longer held; its changes cannot be applied.');
    }

    const outcome = cancelled ? { status: 'cancelled', verification: checks.length ? 'not-run' : 'unverified' } : verdict({ executorOk, checks });
    publishFinal();
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
        if (draft.baseWarnings === undefined) draft.baseWarnings = baseWarningsOf(job);
        draft.warnings = [...draft.baseWarnings, ...audit];
        delete draft.error;
        delete draft.needsInput;
        if (outcome.status === 'failed') {
          draft.error = executorOk
            ? { code: 'checks-failed', message: 'At least one check failed.' }
            : { code: timedOut ? 'executor-timeout' : executorRun?.errorCode ?? 'executor-failed', message: executorRun?.error ?? 'The executor failed.' };
          // The executor stopped on a question: the job is waiting for an
          // answer (relay_send) rather than broken.
          if (draft.error.code === 'needs-input' && parsed.needsInput) draft.needsInput = parsed.needsInput;
        }
        if (outcome.status === 'cancelled') draft.error = { code: 'cancelled', message: 'The job was cancelled.' };
        // Handing back ends a takeover; the job is the relay's again.
        if (turn.kind === 'collect') delete draft.takeover;
        const entry = draft.turns.at(-1);
        entry.summary = clip(parsed.summary, MAX_TURN_SUMMARY_CHARS);
        entry.changedFiles = changes.files.length;
        recordUsage(draft);
      },
      { type: 'finished', status: outcome.status, verification: outcome.verification, changed: changes.files.length, outOfScope: strays.length },
    );
  } catch (err) {
    try {
      publishFinal();
    } catch {
      // the error below is what matters
    }
    return finish(
      draft => {
        if (!TERMINAL.has(draft.status)) draft.status = 'failed';
        draft.error = { code: err.code ?? 'worker-error', message: err.message };
        // A failure after the executor ran (collecting the patch, say) keeps
        // what the turn already got: its run, summary and checks.
        if (executorRun) draft.executorRun = executorRun;
        if (parsed.summary) {
          draft.summary = clip(parsed.summary);
          draft.turns.at(-1).summary = clip(parsed.summary, MAX_TURN_SUMMARY_CHARS);
        }
        if (checks) {
          draft.checkResults = checks;
          draft.verification = verdict({ executorOk, checks }).verification;
        }
        recordUsage(draft);
      },
      { type: 'finished', status: 'failed', error: err.code ?? 'worker-error' },
    );
  }
}

/** Writes a file whole or not at all: a reader never sees it half written. */
function writeFileAtomic(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, text);
  try {
    renameWithRetry(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true }); // no half-finished file left beside it
    throw err;
  }
}
