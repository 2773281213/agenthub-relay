// The codexhost executor backend: a job runs as a Thread of the codex-host
// Host (BytePioneer-AI/codex-host) on one of its harnesses, through the
// documented `codexhost` CLI (JSON output only). One turn is:
//
//   dispatch: delegate start --harness <h> --cwd <worktree> --task-file -
//   send:     thread send <thread> --message-file - [--interrupt]
//   then:     thread wait <thread> until the turn is terminal or asks a question
//
// A cancel or a timeout cancels the Thread's turn (`thread cancel`); stopping
// the CLI alone would leave the turn running in the Host. A question from the
// harness ends the turn as needs-input; the planner answers with a send (which
// interrupts the waiting turn) or opens the Thread in Codex Desktop.
//
// The Host starts the harness itself, so AGENTHUB_RELAY_ROLE does not reach
// it: policy.isExecutorCaller recognizes it by its Thread id instead.

import { runProcess } from './checks.mjs';
import { resolveCommand } from './platform.mjs';

/** How long one `thread wait` call blocks (the Host returns sooner when the turn ends). */
export const WAIT_SLICE_MS = 60_000;
/** Extra time a CLI call gets over the wait it asks for. */
const CALL_GRACE_MS = 30_000;
/** Consecutive failed wait calls (Host restarting, listener down) before the turn fails. */
const MAX_WAIT_FAILURES = 5;
const RETRY_MS = 5_000;
const MAX_TASK_NAME_CHARS = 120;

/** The variables the codexhost CLI may need to reach the Host; the Runtime ones are left out (see envFor). */
export const CODEXHOST_ENV = Object.freeze([
  'CODEXHOST_DATA_DIR',
  'CODEXHOST_CLI_PATH',
  'CODEXHOST_CLI_NODE_PATH',
  'CODEXHOST_CLIENT_TOKEN',
  'CODEXHOST_CLIENT_TOKEN_FILE',
  'CODEXHOST_EXTERNAL_CLIENT_PORT',
]);

/** Thread states after which nothing more happens in the turn. */
const RUNNING = new Set(['running', 'queued', 'starting', 'pending', 'in_progress', 'inProgress', 'active']);

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function parseJson(text) {
  try {
    const value = JSON.parse(String(text ?? '').trim());
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The environment the CLI runs with: the executor's, plus the codexhost
 * variables of the relay's own environment that tell the CLI where the Host
 * is. CODEXHOST_RUNTIME_* (set inside a codexhost session) and the caller's
 * Thread ids are dropped: a stale Runtime endpoint fails with
 * RUNTIME_UNREACHABLE instead of falling back to the local credentials, and a
 * Thread id would make the Host take the relay's caller for the parent.
 */
export function envFor(executorEnv, source = {}) {
  const env = { ...executorEnv };
  for (const name of CODEXHOST_ENV) {
    if (source[name] !== undefined && env[name] === undefined) env[name] = source[name];
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith('CODEXHOST_RUNTIME_') || name === 'CODEXHOST_THREAD_ID' || name === 'CODEX_THREAD_ID') delete env[name];
  }
  return env;
}

/** The selection flags for a job: --model <ref> and --thinking <option> through the executor's templates. */
function selectionArgs(job, cfg) {
  const fill = (template, key, value) => template.map(arg => arg.replaceAll(`{${key}}`, value));
  return [
    ...(job.model !== undefined && cfg.modelArgs?.length ? fill(cfg.modelArgs, 'model', job.model) : []),
    ...(job.effort !== undefined && cfg.effortArgs?.length ? fill(cfg.effortArgs, 'effort', job.effort) : []),
  ];
}

function taskName(title) {
  const line = String(title ?? '').split('\n')[0].trim() || 'agenthub-relay job';
  return line.length > MAX_TASK_NAME_CHARS ? `${line.slice(0, MAX_TASK_NAME_CHARS - 1)}…` : line;
}

/** The questions a snapshot is waiting on, as plain text the planner can answer. */
export function questionsOf(snapshot) {
  const pending = Array.isArray(snapshot?.pendingQuestions) ? snapshot.pendingQuestions : [];
  return pending.map(question => {
    if (typeof question === 'string') return { text: question };
    const text = [question?.question, question?.prompt, question?.text, question?.title, question?.message].find(value => typeof value === 'string' && value.trim());
    const options = (Array.isArray(question?.options) ? question.options : Array.isArray(question?.choices) ? question.choices : [])
      .map(option => (typeof option === 'string' ? option : option?.label ?? option?.text ?? option?.id))
      .filter(option => typeof option === 'string');
    return {
      ...(typeof question?.id === 'string' ? { id: question.id } : typeof question?.interactionId === 'string' ? { id: question.interactionId } : {}),
      text: text ?? JSON.stringify(question).slice(0, 2_000),
      ...(options.length ? { options } : {}),
    };
  });
}

/**
 * What one finished wait means for the turn: still running, done, failed, or
 * waiting for an answer. `turnId` is the turn this run started; a snapshot of
 * an earlier turn (the Host has not switched yet) counts as still running.
 */
export function readSnapshot(snapshot, turnId) {
  const questions = questionsOf(snapshot);
  if (questions.length) return { state: 'needs-input', questions, summary: textOf(snapshot) };
  const turn = snapshot?.turn ?? {};
  if (turnId && turn.turnId && turn.turnId !== turnId) return { state: 'running' };
  const status = String(turn.status ?? snapshot?.status ?? '');
  if (status === '' || RUNNING.has(status) || snapshot?.timedOut === true) return { state: 'running' };
  // A Thread that is done without the turn this run started has not run it
  // (seen with a harness whose start timed out: no turns, status completed).
  if (turnId && !turn.turnId) {
    return { state: 'failed', status, message: `the Host reports the Thread ${status} without the turn the relay started (${turnId}); the harness may have failed to start` };
  }
  if (status === 'completed') return { state: 'completed', summary: textOf(snapshot) };
  const message = typeof snapshot?.result?.message === 'string' ? snapshot.result.message : undefined;
  return { state: 'failed', status, summary: textOf(snapshot), ...(message ? { message } : {}) };
}

function textOf(snapshot) {
  const result = snapshot?.result;
  return typeof result?.text === 'string' ? result.text : '';
}

/**
 * Runs one turn of a codexhost job and reports it the way the worker reports
 * a process run: `{ run, parsed }`, where run has exitCode, timedOut,
 * cancelled, durationMs, stdout and stderr (every CLI call's output, also in
 * the turn's executor log), and parsed has ok, summary, sessionId, error and,
 * for a question, errorCode 'needs-input' with needsInput.questions.
 *
 * @param {object} input
 * @param {object} input.job the job record
 * @param {object} input.cfg the executor settings, with the located command
 * @param {string} input.prompt the task (dispatch) or the follow-up message (send)
 * @param {string} [input.sessionId] the job's Thread, for a send
 * @param {boolean} [input.interrupt] stop an active turn before sending (an answer to a question)
 * @param {Function} [input.onSession] called with the Thread id as soon as it is known
 */
export async function driveCodexhost({
  job, cfg, prompt, sessionId, interrupt = false, cwd, env, signal, timeoutMs, logFile, redact = [], platform = process.platform,
  onSession = () => {}, run = runProcess, waitSliceMs = WAIT_SLICE_MS, retryMs = RETRY_MS, now = Date.now,
}) {
  const started = now();
  const deadline = timeoutMs ? started + timeoutMs : Infinity;
  const out = [];
  const err = [];
  let timedOut = false;
  let cancelled = false;
  const resolved = (() => {
    try {
      return resolveCommand(cfg.command, { env, platform });
    } catch {
      return null;
    }
  })();
  const head = resolved ? [resolved.file, ...resolved.prefixArgs] : [cfg.command];
  const launchEnv = { ...env, ...(resolved?.env ?? {}) };

  const call = async (args, { stdin = null, waitMs = 0, abortable = false } = {}) => {
    const result = await run({
      argv: [...head, ...args, '--format', 'json'],
      cwd,
      env: launchEnv,
      stdin,
      timeoutMs: waitMs + CALL_GRACE_MS,
      logFile,
      signal: abortable ? signal : undefined,
      redact,
      platform,
    });
    out.push(result.stdout ?? '');
    err.push(result.stderr ?? '');
    const body = parseJson(result.stdout);
    const problem = parseJson(result.stderr)?.error;
    return { result, body, problem };
  };
  const report = parsed => ({
    run: {
      exitCode: parsed.ok ? 0 : 1,
      signal: null,
      timedOut,
      cancelled,
      durationMs: now() - started,
      stdout: out.join(''),
      stderr: err.join(''),
    },
    parsed: { ...parsed, sessionId: parsed.sessionId ?? thread },
  });
  const failure = (message, extra = {}) => report({ ok: false, summary: extra.summary ?? '', error: message, ...extra });
  const describe = ({ result, problem }, what) => {
    if (result.spawnError) return `Could not start ${cfg.command}: ${result.spawnError.code ?? result.spawnError.message}`;
    if (problem?.code) return `${what} failed: ${problem.code}${problem.message ? `: ${problem.message}` : ''}`;
    return `${what} failed with exit code ${result.exitCode}${result.stderr ? `: ${String(result.stderr).trim().slice(-500)}` : ''}`;
  };
  const cancelTurn = async () => {
    if (thread) await call(['thread', 'cancel', thread]).catch(() => {});
  };

  let thread = sessionId;
  let turnId;
  if (!thread) {
    const delegated = await call(
      ['delegate', 'start', '--harness', job.harness, '--cwd', cwd, '--task-file', '-', '--task-name', taskName(job.title), ...selectionArgs(job, cfg), ...(cfg.extraArgs ?? [])],
      { stdin: prompt },
    );
    if (delegated.result.exitCode !== 0 || typeof delegated.body?.threadId !== 'string') return failure(describe(delegated, 'codexhost delegate start'));
    thread = delegated.body.threadId;
    turnId = delegated.body.turnId;
    await onSession(thread);
  } else {
    const sent = await call(['thread', 'send', thread, '--message-file', '-', ...(interrupt ? ['--interrupt'] : [])], { stdin: prompt });
    if (sent.result.exitCode !== 0) {
      const busy = sent.problem?.code === 'THREAD_BUSY';
      return failure(
        busy
          ? `The codexhost Thread ${thread} is busy with another turn (someone may be working in it in Codex Desktop); nothing was sent. Send again once it is idle, or with interrupt.`
          : describe(sent, 'codexhost thread send'),
        busy ? { errorCode: 'executor-busy' } : {},
      );
    }
    turnId = sent.body?.turnId;
  }

  let failures = 0;
  for (;;) {
    if (signal?.aborted) {
      cancelled = true;
      await cancelTurn();
      return failure('The job was cancelled.');
    }
    const left = deadline - now();
    if (left <= 0) {
      timedOut = true;
      await cancelTurn();
      return failure(`The executor timed out after ${job.timeoutMinutes} min`);
    }
    const slice = Math.max(1_000, Math.min(waitSliceMs, left));
    const waited = await call(['thread', 'wait', thread, '--timeout-ms', String(slice)], { waitMs: slice, abortable: true });
    if (waited.result.cancelled || signal?.aborted) continue; // the loop's top cancels the turn
    if (waited.result.exitCode !== 0 || !waited.body) {
      failures += 1;
      if (failures >= MAX_WAIT_FAILURES) return failure(describe(waited, 'codexhost thread wait'));
      await sleep(retryMs, signal);
      continue;
    }
    failures = 0;
    const seen = readSnapshot(waited.body, turnId);
    if (seen.state === 'running') {
      // A snapshot of the previous turn comes back at once: do not spin on it.
      if (waited.body.timedOut !== true) await sleep(Math.min(retryMs, 1_000), signal);
      continue;
    }
    if (seen.state === 'completed') return report({ ok: true, summary: seen.summary });
    if (seen.state === 'needs-input') {
      return failure('The harness is waiting for an answer to its question.', {
        summary: seen.summary,
        errorCode: 'needs-input',
        needsInput: { questions: seen.questions },
      });
    }
    return failure(`The codexhost turn ended ${seen.status}${seen.message ? `: ${seen.message}` : ''}`, { summary: seen.summary });
  }
}
