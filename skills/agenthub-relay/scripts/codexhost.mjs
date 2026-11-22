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
/** Tries at `delegate start` when a call may have reached the Host (a timeout, a crash): its request id makes them one. */
const START_ATTEMPTS = 2;
/** Tries at `thread cancel` before the job records that its turn may still run. */
const CANCEL_ATTEMPTS = 3;
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

const firstText = (...values) => values.find(value => typeof value === 'string' && value.trim());

function optionLabels(list) {
  return (Array.isArray(list) ? list : [])
    .map(option => (typeof option === 'string' ? option : firstText(option?.label, option?.text, option?.title, option?.id)))
    .filter(option => typeof option === 'string');
}

/** The asynchronous kind: the Host does not pause the turn for it. */
const ASYNC_QUESTION = 'requestUserInputAsync';

/**
 * The questions a snapshot reports, as plain text the planner can answer.
 * codexhost gives each pending question as { interactionId, kind, turnId,
 * request }, the asking harness's own data in `request`: a native
 * requestUserInput carries `request.questions[]` (question or header, and
 * options with labels), an asynchronous one `request.title` and
 * `request.options`. One entry may ask several questions; each is listed.
 */
export function questionsOf(snapshot) {
  const pending = Array.isArray(snapshot?.pendingQuestions) ? snapshot.pendingQuestions : [];
  return pending.flatMap(entry => {
    if (typeof entry === 'string') return [{ text: entry }];
    const request = entry?.request !== null && typeof entry?.request === 'object' ? entry.request : entry;
    const asked = Array.isArray(request?.questions) && request.questions.length ? request.questions : [request];
    const about = {
      ...(typeof entry?.interactionId === 'string' ? { id: entry.interactionId } : typeof entry?.id === 'string' ? { id: entry.id } : {}),
      ...(typeof entry?.kind === 'string' ? { kind: entry.kind } : {}),
      ...(typeof entry?.turnId === 'string' ? { turnId: entry.turnId } : {}),
    };
    return asked.map(question => {
      const options = optionLabels(question?.options ?? question?.choices);
      const text = firstText(question?.question, question?.prompt, question?.title, question?.text, question?.header, question?.message);
      return {
        ...about,
        ...(asked.length > 1 && typeof question?.id === 'string' ? { questionId: question.id } : {}),
        text: text ?? JSON.stringify(question).slice(0, 2_000),
        ...(options.length ? { options } : {}),
      };
    });
  });
}

/**
 * What one finished wait means for the turn: still running, done, failed, or
 * waiting for an answer. `turnId` is the turn this run started; a snapshot of
 * an earlier turn (the Host has not switched yet) counts as still running, and
 * so does a question an earlier turn left open. Only a question that pauses
 * the turn stops it as needs-input: an asynchronous one lets the harness keep
 * working, and is reported as `open` with the outcome.
 */
export function readSnapshot(snapshot, turnId) {
  const turn = snapshot?.turn ?? {};
  // Check whose snapshot this is before its questions: an old turn's question
  // with no turnId of its own would otherwise look like this turn's needs-input.
  if (turnId && turn.turnId && turn.turnId !== turnId) return { state: 'running' };
  const mine = questionsOf(snapshot).filter(question => !turnId || !question.turnId || question.turnId === turnId);
  const blocking = mine.filter(question => question.kind !== ASYNC_QUESTION);
  const open = mine.filter(question => question.kind === ASYNC_QUESTION);
  const withOpen = state => (open.length ? { ...state, open } : state);
  if (blocking.length) return { state: 'needs-input', questions: blocking, summary: textOf(snapshot) };
  const status = String(turn.status ?? snapshot?.status ?? '');
  if (status === '' || RUNNING.has(status) || snapshot?.timedOut === true) return withOpen({ state: 'running' });
  // A Thread that is done without the turn this run started has not run it
  // (seen with a harness whose start timed out: no turns, status completed).
  if (turnId && !turn.turnId) {
    return { state: 'failed', status, message: `the Host reports the Thread ${status} without the turn the relay started (${turnId}); the harness may have failed to start` };
  }
  if (status === 'completed') return withOpen({ state: 'completed', summary: textOf(snapshot) });
  const message = typeof snapshot?.result?.message === 'string' ? snapshot.result.message : undefined;
  return withOpen({ state: 'failed', status, summary: textOf(snapshot), ...(message ? { message } : {}) });
}

/** A line for the planner about questions a turn left open (asynchronous: the turn went on without an answer). */
function openWarning(thread, open) {
  return `The harness left ${open.length === 1 ? 'a question' : `${open.length} questions`} open in codexhost Thread ${thread}: ${open.map(question => `"${question.text}"${question.options ? ` (${question.options.join(' / ')})` : ''}`).join('; ')}. Answer with relay_send if it matters.`;
}

function textOf(snapshot) {
  const result = snapshot?.result;
  return typeof result?.text === 'string' ? result.text : '';
}

/** One codexhost CLI call outside a job's turn: { ok, body, problem, result }. `env` is already filtered (see envFor). */
async function cliCall({ command, args, env, platform = process.platform, run = runProcess, stdin = null, timeoutMs = CALL_GRACE_MS }) {
  let resolved = null;
  try {
    resolved = resolveCommand(command, { env, platform });
  } catch {
    resolved = null;
  }
  const head = resolved ? [resolved.file, ...resolved.prefixArgs] : [command];
  const result = await run({ argv: [...head, ...args, '--format', 'json'], env: { ...env, ...(resolved?.env ?? {}) }, stdin, timeoutMs, platform });
  return { ok: result.exitCode === 0, body: parseJson(result.stdout), problem: parseJson(result.stderr)?.error, result };
}

/**
 * Cancels the active turn of a Thread (an idle Thread is fine too), for a
 * job that is let go while its harness still waits, such as a needs-input job
 * that is discarded. Resolves with whether the Host took the request.
 */
export async function cancelThread({ command, thread, env, platform, run, attempts = CANCEL_ATTEMPTS, retryMs = RETRY_MS }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const called = await cliCall({ command, args: ['thread', 'cancel', thread], env, platform, run });
    if (called.ok) return true;
    if (called.problem?.code === 'THREAD_NOT_FOUND') return true; // nothing left to stop
    if (attempt < attempts) await sleep(retryMs);
  }
  return false;
}

/** The harness ids `codexhost harness list` names (installed or not), or [] when the Host cannot be asked. */
export async function listHarnesses({ command, env, platform, run, timeoutMs = 15_000 }) {
  const called = await cliCall({ command, args: ['harness', 'list'], env, platform, run, timeoutMs });
  const list = called.ok && Array.isArray(called.body?.harnesses) ? called.body.harnesses : [];
  return list.map(entry => (typeof entry === 'string' ? entry : entry?.id)).filter(id => typeof id === 'string' && HARNESS_ID.test(id));
}

const HARNESS_ID = /^[A-Za-z0-9._-]{1,64}$/;

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
  /** What the job's record should say about the Host beyond the turn's outcome. */
  const warnings = [];
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
    parsed: { ...parsed, sessionId: parsed.sessionId ?? thread, ...(warnings.length ? { warnings: [...warnings] } : {}) },
  });
  // The summary goes last: an `extra` that has none must not unset it.
  const failure = (message, extra = {}) => report({ ok: false, error: message, ...extra, summary: extra.summary ?? '' });
  const describe = ({ result, problem }, what) => {
    if (result.spawnError) return `Could not start ${cfg.command}: ${result.spawnError.code ?? result.spawnError.message}`;
    if (result.timedOut) return `${what} did not answer within ${Math.round((CALL_GRACE_MS) / 1000)} s`;
    if (problem?.code) return `${what} failed: ${problem.code}${problem.message ? `: ${problem.message}` : ''}`;
    return `${what} failed with exit code ${result.exitCode}${result.stderr ? `: ${String(result.stderr).trim().slice(-500)}` : ''}`;
  };
  // Stopping only the CLI would leave the turn running in the Host, so the
  // cancel is retried; when it never gets through, the job says so.
  const cancelTurn = async () => {
    if (!thread) return;
    let last;
    for (let attempt = 1; attempt <= CANCEL_ATTEMPTS; attempt += 1) {
      last = await call(['thread', 'cancel', thread]);
      if (last.result.exitCode === 0) return; // cancelled, or the Thread was idle already
      if (last.problem?.code === 'THREAD_NOT_FOUND') return; // no Thread left to run anything
      if (attempt < CANCEL_ATTEMPTS) await sleep(retryMs); // the job's signal is aborted by now: not abortable
    }
    warnings.push(`The relay could not cancel the turn of codexhost Thread ${thread} (${describe(last, 'codexhost thread cancel')}); it may still be running in the Host. Stop it in Codex Desktop.`);
  };

  let thread = sessionId;
  let turnId;
  if (!thread) {
    // The request id makes a retry return the Thread the first call started,
    // so a call that timed out after the Host took it does not start a second one.
    const args = [
      'delegate', 'start', '--harness', job.harness, '--cwd', cwd, '--task-file', '-', '--task-name', taskName(job.title),
      '--request-id', `agenthub-relay-${job.id}`, ...selectionArgs(job, cfg), ...(cfg.extraArgs ?? []),
    ];
    let delegated;
    for (let attempt = 1; ; attempt += 1) {
      delegated = await call(args, { stdin: prompt });
      if (delegated.result.exitCode === 0 && typeof delegated.body?.threadId === 'string') break;
      const mayHaveStarted = !delegated.result.spawnError && !delegated.problem?.code;
      if (!mayHaveStarted || attempt >= START_ATTEMPTS || signal?.aborted) return failure(describe(delegated, 'codexhost delegate start'));
      await sleep(retryMs, signal);
    }
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
  /** Asynchronous questions the turn asked and went on without; reported with its outcome. */
  let open = [];
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
      if (failures >= MAX_WAIT_FAILURES) {
        warnings.push(`The relay lost touch with codexhost Thread ${thread} while its turn ran; the turn may still be running in the Host.`);
        return failure(describe(waited, 'codexhost thread wait'));
      }
      await sleep(retryMs, signal);
      continue;
    }
    failures = 0;
    const seen = readSnapshot(waited.body, turnId);
    // A terminal snapshot (or one of this turn) is authoritative about what is
    // still open: an asynchronous question answered before the turn ended must
    // not stay on the old list.
    if (seen.state !== 'running' || !turnId || waited.body?.turn?.turnId === turnId) open = seen.open ?? [];
    if (seen.state === 'running') {
      // A snapshot of the previous turn comes back at once, and so does every
      // wait while an asynchronous question is open: do not spin on them. The
      // Host may still list a previous turn's async question, so count its
      // pendingQuestions too, even when readSnapshot filtered them out.
      const waitingOnQuestion = seen.open?.length || waited.body?.pendingQuestions?.length;
      if (waited.body.timedOut !== true) await sleep(waitingOnQuestion ? retryMs : Math.min(retryMs, 1_000), signal);
      continue;
    }
    if (open.length) warnings.push(openWarning(thread, open));
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
