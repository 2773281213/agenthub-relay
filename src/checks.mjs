// Running child processes for the worker: the executor itself and the
// planner's check commands. Every child gets its own process group so that a
// timeout or a cancel ends it together with anything it started.
//
// Check records follow Birdview's semantics: passed requires exit code 0,
// failed requires a non-zero exit code, not-run requires a null exit code.
// Values of credentials passed by name are redacted from logs and output.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** The exit code recorded for a command stopped by its timeout. */
export const TIMEOUT_EXIT_CODE = 124;
export const KILL_GRACE_MS = 5_000;
export const REDACTED = '[redacted]';

const MAX_LOG_CHARS = 20 * 1024 * 1024;
const MAX_STDOUT_CHARS = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 1024 * 1024;
/** Shorter values would redact ordinary words. */
const MIN_SECRET_CHARS = 6;

/** Signals the whole process group led by `pid` (ESRCH means it is gone). */
export function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalNumber(signal) {
  return os.constants.signals[signal] ?? 1;
}

/**
 * Decodes a byte stream to text with every listed value replaced by
 * [redacted], including values split across chunks: the text is scrubbed
 * before it is cut, and the tail that could still start a value is held back.
 */
export function createRedactor(values = []) {
  const secrets = [...new Set(values.filter(value => typeof value === 'string' && value.length >= MIN_SECRET_CHARS))].sort(
    (a, b) => b.length - a.length,
  );
  const decoder = new StringDecoder('utf8');
  if (secrets.length === 0) return { push: chunk => decoder.write(chunk), end: () => decoder.end() };
  const scrub = text => secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED), text);
  const hold = secrets[0].length - 1;
  let carry = '';
  return {
    push(chunk) {
      const text = scrub(carry + decoder.write(chunk));
      const cut = Math.max(0, text.length - hold);
      carry = text.slice(cut);
      return text.slice(0, cut);
    },
    end() {
      const rest = scrub(carry + decoder.end());
      carry = '';
      return rest;
    },
  };
}

/** `text` with every listed value replaced by [redacted]. */
export function redactText(text, values = []) {
  const redactor = createRedactor(values);
  return redactor.push(Buffer.from(text, 'utf8')) + redactor.end();
}

class Capture {
  constructor(limit) {
    this.limit = limit;
    this.parts = [];
    this.size = 0;
  }

  push(text) {
    if (text === '' || this.size >= this.limit) return;
    const piece = text.length > this.limit - this.size ? text.slice(0, this.limit - this.size) : text;
    this.parts.push(piece);
    this.size += piece.length;
  }

  text() {
    return this.parts.join('');
  }
}

/**
 * Runs one command in its own process group and resolves when it ends.
 * Never rejects: a command that cannot start resolves with `spawnError`.
 * Output reaches the log, `stdout` and `stderr` with `redact` values replaced.
 */
export function runProcess({ argv, cwd, env, stdin = null, timeoutMs, logFile, signal, redact = [] }) {
  return new Promise(resolve => {
    const started = Date.now();
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    let logged = 0;
    const toLog = text => {
      if (!log || text === '' || logged >= MAX_LOG_CHARS) return;
      logged += text.length;
      log.write(text);
      if (logged >= MAX_LOG_CHARS) log.write('\n[agenthub-relay: log truncated at 20 MB]\n');
    };
    const stdout = new Capture(MAX_STDOUT_CHARS);
    const stderr = new Capture(MAX_STDERR_CHARS);
    const outRedactor = createRedactor(redact);
    const errRedactor = createRedactor(redact);
    const take = (capture, text) => {
      capture.push(text);
      toLog(text);
    };
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer;
    let killTimer;
    let child;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      take(stdout, outRedactor.end());
      take(stderr, errRedactor.end());
      const done = () => resolve({ ...result, timedOut, cancelled, durationMs: Date.now() - started, stdout: stdout.text(), stderr: stderr.text() });
      if (log) log.end(done);
      else done();
    };

    const stop = () => {
      if (!child?.pid) return;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };

    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        detached: true,
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ exitCode: null, signal: null, spawnError: err });
      return;
    }

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
    }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', chunk => take(stdout, outRedactor.push(chunk)));
    child.stderr.on('data', chunk => take(stderr, errRedactor.push(chunk)));
    if (stdin !== null) {
      child.stdin.on('error', () => {}); // the command may exit without reading
      child.stdin.end(stdin);
    }
    child.on('error', err => finish({ exitCode: null, signal: null, spawnError: err }));
    let exited;
    child.on('exit', (code, sig) => {
      exited = { exitCode: code, signal: sig };
      // Anything the command left running in its group goes with it; that
      // also closes pipes a leftover process would otherwise hold open.
      signalGroup(child.pid, 'SIGKILL');
    });
    child.on('close', (code, sig) => finish(exited ?? { exitCode: code, signal: sig }));
  });
}

/** The exit code a check is recorded with (never null once it ran). */
export function recordedExitCode(run) {
  if (run.timedOut) return TIMEOUT_EXIT_CODE;
  if (Number.isInteger(run.exitCode)) return run.exitCode;
  if (run.signal) return 128 + signalNumber(run.signal);
  return 1;
}

function lastLine(text) {
  const lines = text.trim().split('\n').filter(line => line.trim() !== '');
  const line = lines.at(-1) ?? '';
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

/** Checks that did not run, recorded with a null exit code. */
export function notRun(commands, reason) {
  return commands.map(command => ({ command, status: 'not-run', exitCode: null, summary: reason }));
}

/** Runs the planner's checks one after another in the job's worktree. */
export async function runChecks(commands, { cwd, env, timeoutMs, logDir, signal, redact = [] }) {
  const results = [];
  for (const [index, command] of commands.entries()) {
    if (signal?.aborted) {
      results.push(...notRun(commands.slice(index), 'not run: the job was cancelled'));
      break;
    }
    const logFile = path.join(logDir, `${index}.log`);
    const run = await runProcess({ argv: ['/bin/sh', '-c', command], cwd, env, timeoutMs, logFile, signal, redact });
    if (run.spawnError) {
      results.push({ command, status: 'failed', exitCode: 127, summary: `could not start: ${run.spawnError.message}`, log: logFile });
      continue;
    }
    if (run.cancelled && !run.timedOut) {
      results.push(...notRun(commands.slice(index), 'not run: the job was cancelled'));
      break;
    }
    const exitCode = recordedExitCode(run);
    const detail = run.timedOut ? ` (timed out after ${Math.round(timeoutMs / 1000)} s)` : '';
    const last = lastLine(`${run.stdout}\n${run.stderr}`);
    results.push({
      command,
      status: exitCode === 0 ? 'passed' : 'failed',
      exitCode,
      summary: `exit ${exitCode}${detail}${last ? `: ${last}` : ''}`,
      durationMs: run.durationMs,
      log: logFile,
    });
  }
  return results;
}

/**
 * The job's final status and verification from what ran: a job with any
 * failed check, or whose executor failed, ends failed; no checks means the
 * work is unverified, not passed.
 */
export function verdict({ executorOk, checks }) {
  const allPassed = checks.every(check => check.status === 'passed');
  const anyFailed = checks.some(check => check.status === 'failed');
  return {
    status: executorOk && allPassed ? 'completed' : 'failed',
    verification: checks.length === 0 ? 'unverified' : allPassed ? 'passed' : anyFailed ? 'failed' : 'not-run',
  };
}
