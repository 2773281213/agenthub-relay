// Waking a planner that is not Claude Code, and what each planner can do to
// keep its prompt cache warm while it waits.
//
// A planner that runs in a codexhost Thread (a codex-host harness, which has
// CODEXHOST_THREAD_ID, or a Codex Desktop Thread the Host manages, which has
// CODEX_THREAD_ID) can be woken the way codex-host's own watches do it: a new
// turn in its Thread, `codexhost thread send <thread>`, telling it which jobs
// ended. One waker process per planner Thread (`agenthub-relay wake
// <thread>`) does that: it starts with the first job dispatched from the
// Thread, merges the jobs that end together into one message, retries while
// the Thread is busy, drops a notice once the job's result has been read, it
// was applied, discarded or taken over, or another turn started, and exits
// when the Thread has no running job and nothing left to tell.
//
// Claude Code planners are woken, and kept warm, by the mod in hooks/. The
// others wait with relay_wait; PLANNER_KEEPALIVE says why none of them is
// kept warm.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProcess } from './checks.mjs';
import { envFor } from './codexhost.mjs';
import { locateExecutor } from './discovery.mjs';
import { BASE_ENV, SESSION_ID, spawnArgv } from './executors.mjs';
import { workerSpawnOptions } from './platform.mjs';
import { createStore, isAlive, LIVE, resultFetched, TERMINAL, turnNumber } from './store.mjs';

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));

/** How often the waker looks at the jobs. */
export const WAKE_TICK_MS = 15_000;
/** How long a notice is retried while the planner's Thread stays busy. */
export const NOTICE_TTL_MS = 6 * 60 * 60_000;
/** Consecutive failed sends that are not THREAD_BUSY before the waker gives up. */
const MAX_SEND_FAILURES = 3;

/**
 * Keeping each planner's prompt cache warm while relay jobs run. A refresh
 * has to resend the planner's own conversation without adding a turn to it;
 * where that cannot be done the planner is not kept warm. Measured on this
 * relay's own probes (2026-11).
 */
export const PLANNER_KEEPALIVE = Object.freeze({
  claude: {
    keepAlive: 'supported',
    how: 'The Claude Code mod refreshes the cache with $.model.fork while jobs run (every 55 minutes, at most 8 hours); it adds nothing to the transcript.',
  },
  codex: {
    keepAlive: 'unsupported',
    reason: 'codex exec resume --ephemeral still appends the refresh prompt and its reply to the Thread\'s rollout (Codex 26.1117), so every refresh would be a turn in the planner\'s conversation.',
  },
  dsh: {
    keepAlive: 'not-needed',
    reason: "DeepSeek's disk cache keeps a prefix for hours to days without a write premium; resuming the session to refresh it would add a turn.",
  },
  agy: {
    keepAlive: 'unsupported',
    reason: 'Antigravity records every --conversation run as a turn and has no run that leaves the conversation as it is; Gemini caching is implicit.',
  },
});

/** The Thread a planner runs in, as codexhost exports it, or undefined. */
export function plannerThread(env = {}) {
  for (const name of ['CODEXHOST_THREAD_ID', 'CODEX_THREAD_ID']) {
    const value = env[name];
    if (typeof value === 'string' && SESSION_ID.test(value)) return value;
  }
  return undefined;
}

/** The jobs whose end the planner of `thread` has not been told about yet. */
export function pendingNotices(jobs, thread, now = Date.now()) {
  return jobs.filter(job =>
    job.wake?.thread === thread
    && TERMINAL.has(job.status)
    && (job.integration ?? 'none') === 'none'
    && !job.takeover
    && !resultFetched(job)
    && job.wake.notifiedTurn !== turnNumber(job)
    && now - Date.parse(job.endedAt ?? job.createdAt) < NOTICE_TTL_MS);
}

/** The message that wakes the planner; the same words as the Claude Code mod's. */
export function wakeMessage(jobs) {
  const lines = jobs.map(job => {
    const n = turnNumber(job);
    const waiting = job.status === 'failed' && job.error?.code === 'needs-input';
    const how = waiting ? 'is waiting for your answer' : `ended ${job.status}${job.verification ? `, checks ${job.verification}` : ''}`;
    return `- ${job.id} (${job.executor}, ${job.tier}) ${how}${n > 1 ? ` (turn ${n})` : ''}: ${job.title ?? ''}`;
  });
  return [
    `[agenthub-relay] ${jobs.length === 1 ? 'A job you dispatched has' : `${jobs.length} jobs you dispatched have`} ended. Read each job's result, then continue your task:`,
    ...lines,
    'Read each with relay_result (agenthub-relay result <id>). Then apply it, send its session what to change, or discard it.',
  ].join('\n');
}

function lockFile(root, thread) {
  return path.join(createStore(root).dir, 'wake', `${thread.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Claims the planner Thread's waker lock for this process: the lock names a
 * pid, and only a lock whose pid is gone is taken over. Returns false when
 * another waker holds it.
 */
export function claimWaker(root, thread, pid = process.pid) {
  const file = lockFile(root, thread);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, thread, startedAt: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = readLock(file);
      if (held?.pid === pid) return true;
      if (held && isAlive(held.pid)) return false;
      try {
        fs.unlinkSync(file);
      } catch {
        // another waker took it first, or Windows holds it for a moment
      }
    }
  }
  return false;
}

function releaseWaker(root, thread, pid = process.pid, note) {
  const file = lockFile(root, thread);
  const held = readLock(file);
  if (held?.pid !== pid) return;
  if (note) {
    // What stopped it stays for status; the pid is gone, so the next job can claim it.
    fs.writeFileSync(file, JSON.stringify({ ...held, pid: null, endedAt: new Date().toISOString(), note }));
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // gone already
  }
}

/** What the waker of a planner Thread last recorded, for status: running, or why it stopped. */
export function wakerState(root, thread) {
  const held = readLock(lockFile(root, thread));
  if (!held) return null;
  return { running: isAlive(held.pid), ...(held.note ? { note: held.note } : {}), ...(held.lastSentAt ? { lastSentAt: held.lastSentAt } : {}) };
}

/**
 * Starts the waker for a planner Thread unless one runs. The waker itself
 * settles a race between two of them (claimWaker); this only avoids starting
 * a process that would exit at once.
 */
export function ensureWaker(root, thread, env, { start = startWakerProcess } = {}) {
  const held = readLock(lockFile(root, thread));
  if (held && isAlive(held.pid)) return held.pid;
  return start(root, thread, env);
}

export function startWakerProcess(root, thread, env) {
  const log = path.join(createStore(root).dir, 'wake', 'wake.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  try {
    const child = spawn(process.execPath, [CLI, 'wake', thread], {
      cwd: root,
      env: { ...env, AGENTHUB_RELAY_ROOT: root },
      ...workerSpawnOptions(),
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether a codexhost CLI can be found for waking a planner from `env`. */
export function codexhostCommand(config, env, platform = process.platform) {
  const configured = config?.executors?.codexhost?.command ?? 'codexhost';
  const located = locateExecutor('codexhost', configured, { env, platform });
  return located.resolved ? located.command : null;
}

function cliEnv(env) {
  const base = {};
  for (const name of BASE_ENV) if (env[name] !== undefined) base[name] = env[name];
  return envFor(base, env);
}

function argvFor(command, args, env, platform) {
  return spawnArgv([command, ...args], { env, platform });
}

/**
 * Whether the codexhost Host knows `thread`: a Codex CLI in a terminal has a
 * CODEX_THREAD_ID too, but no Host to send its Thread anything. Only a
 * planner whose Thread the Host can read is told it will be woken.
 */
export async function threadReachable({ command, thread, env, platform = process.platform, run = runProcess }) {
  const childEnv = cliEnv(env);
  const launch = argvFor(command, ['thread', 'read', thread, '--format', 'json'], childEnv, platform);
  const read = await run({ argv: launch.argv, cwd: undefined, env: { ...childEnv, ...launch.env }, stdin: null, timeoutMs: 20_000, platform });
  if (read.exitCode !== 0) return false;
  try {
    return JSON.parse(String(read.stdout).trim())?.threadId === thread;
  } catch {
    return false;
  }
}

/**
 * The waker of one planner Thread: runs until the Thread has no running job
 * and no notice left, or until sending keeps failing for another reason than
 * a busy Thread. Resolves with why it stopped.
 */
export async function runWaker({
  root, thread, env = process.env, command, platform = process.platform, run = runProcess,
  tickMs = WAKE_TICK_MS, now = Date.now, signal, log = () => {},
}) {
  if (!claimWaker(root, thread)) return { stopped: 'another-waker' };
  const store = createStore(root);
  const childEnv = cliEnv(env);
  let failures = 0;
  let note;
  try {
    for (;;) {
      if (signal?.aborted) return { stopped: 'aborted' };
      const jobs = store.list().filter(job => job.wake?.thread === thread);
      const due = pendingNotices(jobs, thread, now());
      if (due.length) {
        const launch = argvFor(command, ['thread', 'send', thread, '--message-file', '-', '--format', 'json'], childEnv, platform);
        const sent = await run({
          argv: launch.argv,
          cwd: root,
          env: { ...childEnv, ...launch.env },
          stdin: wakeMessage(due),
          timeoutMs: 60_000,
          platform,
        });
        let problem;
        try {
          problem = JSON.parse(String(sent.stderr ?? '').trim())?.error;
        } catch {
          problem = undefined;
        }
        if (sent.exitCode === 0) {
          failures = 0;
          for (const job of due) {
            const n = turnNumber(job);
            await store.update(job.id, draft => {
              // Only the turn the notice was about: a later turn gets its own.
              if (turnNumber(draft) === n) draft.wake = { ...draft.wake, notifiedTurn: n, notifiedAt: new Date(now()).toISOString() };
            });
          }
          const file = lockFile(root, thread);
          const held = readLock(file);
          if (held?.pid === process.pid) fs.writeFileSync(file, JSON.stringify({ ...held, lastSentAt: new Date(now()).toISOString() }));
          log(`woke ${thread} for ${due.map(job => job.id).join(', ')}`);
        } else if (problem?.code === 'THREAD_BUSY') {
          log(`${thread} is busy; trying again`); // the planner is in a turn: next tick
        } else {
          failures += 1;
          log(`could not wake ${thread}: ${problem?.code ?? `exit ${sent.exitCode}`} ${problem?.message ?? ''}`);
          if (failures >= MAX_SEND_FAILURES) {
            note = `codexhost thread send failed ${failures} times: ${problem?.code ?? `exit ${sent.exitCode}`}${problem?.message ? ` ${problem.message}` : ''}`;
            return { stopped: 'send-failed', note };
          }
        }
      } else if (!jobs.some(job => LIVE.has(job.status))) {
        return { stopped: 'idle' };
      }
      await new Promise(resolve => {
        const timer = setTimeout(resolve, tickMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  } finally {
    releaseWaker(root, thread, process.pid, note);
  }
}
