// Job records and their state machine, kept as plain files under
// <root>/.agenthub so that the MCP server, workers and any planner on the same
// machine share one view. Writes are atomic (write then rename) and every
// read-modify-write holds a lock file created with O_EXCL.
//
// A job runs in turns: the dispatch is turn 1, and each follow-up (relay_send)
// or hand-back (relay_collect) adds one. `turns` lists them, the last one being
// the turn in progress or the latest; the top-level fields describe that
// latest turn, so readers that predate turns keep working.
//
// Records hold environment variable NAMES only, never values.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { renameWithRetry } from './platform.mjs';

export const STATUSES = Object.freeze(['queued', 'running', 'verifying', 'completed', 'failed', 'cancelled']);
export const TERMINAL = Object.freeze(new Set(['completed', 'failed', 'cancelled']));
export const LIVE = Object.freeze(new Set(['queued', 'running', 'verifying']));
/**
 * `applying` and `discarding` reserve a job while apply or discard works on
 * git outside the job's lock; they end as applied/discarded, or back at none.
 */
export const INTEGRATIONS = Object.freeze(['none', 'applying', 'discarding', 'applied', 'discarded']);
export const RESERVATIONS = Object.freeze(new Set(['applying', 'discarding']));
export const TURN_KINDS = Object.freeze(['dispatch', 'send', 'collect']);

const TRANSITIONS = Object.freeze({
  queued: ['running', 'verifying', 'failed', 'cancelled'],
  running: ['verifying', 'failed', 'cancelled'],
  verifying: ['completed', 'failed', 'cancelled'],
  // A finished job starts another turn only through queued (send or collect).
  completed: ['queued'],
  failed: ['queued'],
  cancelled: ['queued'],
});

const INTEGRATION_TRANSITIONS = Object.freeze({
  none: ['applying', 'discarding', 'applied', 'discarded'],
  applying: ['applied', 'none'],
  discarding: ['discarded', 'none'],
  applied: [],
  discarded: [],
});

/** How often a worker refreshes its heartbeat. */
export const HEARTBEAT_MS = 30_000;
/** A live job whose worker is gone and whose heartbeat is older than this is lost. */
export const LOST_AFTER_MS = 90_000;
/** A heartbeat this old means the worker is lost even if its pid is reused. */
export const STALLED_AFTER_MS = 5 * 60_000;
/** An apply or discard reservation older than this is abandoned, whatever its pid says. */
export const RESERVATION_STALE_MS = 10 * 60_000;

const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const JOB_ID = /^j\d{8}-\d{6}-[0-9a-f]{6}$/;
const IMMUTABLE = ['id', 'createdAt', 'tier', 'executor', 'write', 'worktree', 'branch'];

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A sortable, path-safe job id such as j20261029-061530-a1b2c3. */
export function newJobId(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `j${day}-${time}-${crypto.randomBytes(3).toString('hex')}`;
}

export function isJobId(value) {
  return typeof value === 'string' && JOB_ID.test(value);
}

function assertJobId(id) {
  if (!isJobId(id)) throw fail('unknown-job', `"${id}" is not a job id`);
}

/** Whether a process with this pid exists (EPERM means it exists). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameWithRetry(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Windows reports a file another process is deleting ("delete pending") as
 * EPERM, EACCES or EBUSY for a moment; for a lock file that means busy.
 */
const BUSY_LOCK = new Set(['EPERM', 'EACCES', 'EBUSY']);

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Removes a lock file. fs.rmSync has been seen to leave files in place on some
 * Windows setups when the path has non-ASCII characters; unlinkSync does not.
 */
function removeLock(lockFile) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.unlinkSync(lockFile);
      return;
    } catch (err) {
      if (err.code === 'ENOENT') return;
      if (!BUSY_LOCK.has(err.code) || attempt >= 50) throw err;
      pause(10);
    }
  }
}

/** Runs `fn` while holding a lock file; a lock older than 30 s is reclaimed. */
export async function withLock(lockFile, fn) {
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' && !BUSY_LOCK.has(err.code)) throw err;
      if (err.code === 'EEXIST') {
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
            removeLock(lockFile);
            continue;
          }
        } catch {
          continue; // released between our attempt and the stat
        }
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw fail('lock-timeout', `Timed out waiting for ${lockFile}`);
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    removeLock(lockFile);
  }
}

/** The job's turns; a record from before turns existed reads as one dispatch turn. */
export function turnsOf(job) {
  if (Array.isArray(job.turns) && job.turns.length > 0) return job.turns;
  return [{
    n: 1,
    kind: 'dispatch',
    by: 'planner',
    status: job.status,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.endedAt ? { endedAt: job.endedAt } : {}),
  }];
}

/** The number of the job's latest turn (1 for a record from before turns existed). */
export function turnNumber(job) {
  return turnsOf(job).at(-1).n;
}

function lastTurnKind(job) {
  return Array.isArray(job.turns) ? job.turns.at(-1)?.kind : undefined;
}

/** Throws unless `next` is a legal successor of `prev`. */
export function checkTransition(prev, next) {
  for (const field of IMMUTABLE) {
    if (JSON.stringify(prev[field]) !== JSON.stringify(next[field])) {
      throw fail('invalid-transition', `Job field "${field}" cannot change`);
    }
  }
  if (!STATUSES.includes(next.status)) throw fail('invalid-transition', `Unknown status "${next.status}"`);
  const before = prev.integration ?? 'none';
  const after = next.integration ?? 'none';
  if (prev.status !== next.status) {
    if (!TRANSITIONS[prev.status].includes(next.status)) {
      throw fail('invalid-transition', `A job cannot move from ${prev.status} to ${next.status}`);
    }
    // Only a hand-back (collect) turn skips the executor.
    if (prev.status === 'queued' && next.status === 'verifying' && lastTurnKind(next) !== 'collect') {
      throw fail('invalid-transition', 'Only a collect turn goes from queued straight to verifying');
    }
    if (TERMINAL.has(prev.status) && next.status === 'queued' && (before !== 'none' || after !== 'none')) {
      throw fail('invalid-transition', `Job ${prev.id} was already ${before === 'none' ? after : before}; it takes no more turns`);
    }
  }
  if (!INTEGRATIONS.includes(after)) throw fail('invalid-transition', `Unknown integration "${after}"`);
  if (before !== after) {
    if (!INTEGRATION_TRANSITIONS[before].includes(after)) {
      throw fail('invalid-transition', `Job ${prev.id} was already ${before}`);
    }
    if (!TERMINAL.has(next.status)) throw fail('invalid-transition', `Job ${prev.id} is still ${next.status}`);
  }
}

/** True when a live job's worker has gone away. */
export function isLost(job, now = Date.now()) {
  if (TERMINAL.has(job.status)) return false;
  // A cancel whose worker is gone needs no grace period.
  if (job.cancelRequested && !isAlive(job.worker?.pid)) return true;
  const last = Date.parse(job.heartbeatAt ?? job.createdAt);
  const age = now - (Number.isFinite(last) ? last : 0);
  if (age <= LOST_AFTER_MS) return false;
  return !isAlive(job.worker?.pid) || age > STALLED_AFTER_MS;
}

/** True when an apply or discard reservation was left behind by a process that is gone. */
export function isAbandonedReservation(job, now = Date.now()) {
  if (!RESERVATIONS.has(job.integration)) return false;
  const since = Date.parse(job.integrationAt ?? '');
  if (!Number.isFinite(since) || now - since > RESERVATION_STALE_MS) return true;
  return !isAlive(job.integrationPid);
}

export function createStore(root) {
  const dir = path.join(root, '.agenthub');
  const jobsDir = path.join(dir, 'jobs');

  function paths(id) {
    assertJobId(id);
    const jobDir = path.join(jobsDir, id);
    return {
      dir: jobDir,
      job: path.join(jobDir, 'job.json'),
      lock: path.join(jobDir, 'job.lock'),
      events: path.join(jobDir, 'events.jsonl'),
      // The latest turn's final message; each turn keeps its own under turns/<n>/.
      final: path.join(jobDir, 'final.md'),
      patch: path.join(jobDir, 'patch.diff'),
      // Where records from before turns kept their logs.
      executorLog: path.join(jobDir, 'executor.log'),
      workerLog: path.join(jobDir, 'worker.log'),
      checksDir: path.join(jobDir, 'checks'),
      turn(n) {
        if (!Number.isInteger(n) || n < 1) throw fail('invalid-request', `"${n}" is not a turn number`);
        const turnDir = path.join(jobDir, 'turns', String(n));
        return {
          dir: turnDir,
          executorLog: path.join(turnDir, 'executor.log'),
          final: path.join(turnDir, 'final.md'),
          checksDir: path.join(turnDir, 'checks'),
        };
      },
    };
  }

  function appendEvent(id, event) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    fs.appendFileSync(paths(id).events, `${line}\n`);
  }

  function read(id) {
    try {
      return readJson(paths(id).job);
    } catch (err) {
      if (err.code === 'ENOENT') throw fail('unknown-job', `No job ${id}`);
      throw err;
    }
  }

  function list() {
    let names;
    try {
      names = fs.readdirSync(jobsDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const jobs = [];
    for (const name of names.filter(isJobId)) {
      try {
        jobs.push(read(name));
      } catch {
        // a job being created or removed right now
      }
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  function create(job) {
    const p = paths(job.id);
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(p.dir); // throws if the id is taken
    fs.mkdirSync(p.checksDir);
    const now = new Date().toISOString();
    const record = { integration: 'none', status: 'queued', ...job, createdAt: job.createdAt ?? now, updatedAt: now };
    if (record.status !== 'queued') throw fail('invalid-transition', 'A new job starts queued');
    writeJsonAtomic(p.job, record);
    appendEvent(job.id, { type: 'created', status: 'queued' });
    return record;
  }

  /** Read-modify-write under the job's lock; `mutate` edits a draft copy. */
  async function update(id, mutate) {
    const p = paths(id);
    return withLock(p.lock, () => {
      const current = read(id);
      const draft = structuredClone(current);
      const next = mutate(draft) ?? draft;
      checkTransition(current, next);
      next.updatedAt = new Date().toISOString();
      writeJsonAtomic(p.job, next);
      if (current.status !== next.status) {
        appendEvent(id, {
          type: 'status',
          from: current.status,
          to: next.status,
          ...(Array.isArray(next.turns) ? { turn: next.turns.at(-1)?.n } : {}),
          ...(next.error ? { error: next.error.code } : {}),
        });
      }
      if ((current.integration ?? 'none') !== next.integration) {
        appendEvent(id, { type: 'integration', to: next.integration });
      }
      return next;
    });
  }

  /**
   * Ends a live job whose worker vanished: cancelled when a cancel was
   * requested, otherwise failed (worker-lost). The turn that was running is
   * closed with the same outcome, so `turns` stays in step with the job.
   */
  async function reconcile(job, now = Date.now()) {
    if (!isLost(job, now)) return job;
    try {
      return await update(job.id, draft => {
        if (!isLost(draft, now)) return draft;
        const endedAt = new Date(now).toISOString();
        draft.endedAt = endedAt;
        if (draft.cancelRequested) {
          draft.status = 'cancelled';
          draft.error = { code: 'cancelled', message: 'The job was cancelled.' };
        } else {
          draft.status = 'failed';
          draft.error = { code: 'worker-lost', message: 'The worker process stopped without finishing the job.' };
        }
        const last = Array.isArray(draft.turns) ? draft.turns.at(-1) : undefined;
        if (last && !TERMINAL.has(last.status)) {
          last.status = draft.status;
          last.endedAt = endedAt;
          last.error = draft.error.code;
        }
        return draft;
      });
    } catch (err) {
      if (err.code === 'invalid-transition') return read(job.id);
      throw err;
    }
  }

  async function withDispatchLock(fn) {
    fs.mkdirSync(dir, { recursive: true });
    return withLock(path.join(dir, 'dispatch.lock'), fn);
  }

  return { root, dir, jobsDir, paths, create, read, list, update, reconcile, appendEvent, withDispatchLock };
}
