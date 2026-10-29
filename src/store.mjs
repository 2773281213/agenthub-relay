// Job records and their state machine, kept as plain files under
// <root>/.agenthub so that the MCP server, workers and any planner on the same
// machine share one view. Writes are atomic (write then rename) and every
// read-modify-write holds a lock file created with O_EXCL.
//
// Records hold environment variable NAMES only, never values.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = Object.freeze(['queued', 'running', 'verifying', 'completed', 'failed', 'cancelled']);
export const TERMINAL = Object.freeze(new Set(['completed', 'failed', 'cancelled']));
export const INTEGRATIONS = Object.freeze(['none', 'applied', 'discarded']);

const TRANSITIONS = Object.freeze({
  queued: ['running', 'failed', 'cancelled'],
  running: ['verifying', 'failed', 'cancelled'],
  verifying: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

/** How often a worker refreshes its heartbeat. */
export const HEARTBEAT_MS = 30_000;
/** A live job whose worker is gone and whose heartbeat is older than this is lost. */
export const LOST_AFTER_MS = 90_000;
/** A heartbeat this old means the worker is lost even if its pid is reused. */
export const STALLED_AFTER_MS = 5 * 60_000;
/** A watcher counts as active while it was seen this recently. */
export const WATCHER_ACTIVE_MS = 3 * 60_000;

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
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue; // released between our attempt and the stat
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw fail('lock-timeout', `Timed out waiting for ${lockFile}`);
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

/** Throws unless `next` is a legal successor of `prev`. */
export function checkTransition(prev, next) {
  for (const field of IMMUTABLE) {
    if (JSON.stringify(prev[field]) !== JSON.stringify(next[field])) {
      throw fail('invalid-transition', `Job field "${field}" cannot change`);
    }
  }
  if (!STATUSES.includes(next.status)) throw fail('invalid-transition', `Unknown status "${next.status}"`);
  if (prev.status !== next.status && !TRANSITIONS[prev.status].includes(next.status)) {
    throw fail('invalid-transition', `A job cannot move from ${prev.status} to ${next.status}`);
  }
  const before = prev.integration ?? 'none';
  const after = next.integration ?? 'none';
  if (!INTEGRATIONS.includes(after)) throw fail('invalid-transition', `Unknown integration "${after}"`);
  if (before !== after) {
    if (before !== 'none') throw fail('invalid-transition', `Job ${prev.id} was already ${before}`);
    if (!TERMINAL.has(next.status)) throw fail('invalid-transition', `Job ${prev.id} is still ${next.status}`);
  }
}

/** True when a live job's worker has gone away. */
export function isLost(job, now = Date.now()) {
  if (TERMINAL.has(job.status)) return false;
  const last = Date.parse(job.heartbeatAt ?? job.createdAt);
  const age = now - (Number.isFinite(last) ? last : 0);
  if (age <= LOST_AFTER_MS) return false;
  return !isAlive(job.worker?.pid) || age > STALLED_AFTER_MS;
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
      executorLog: path.join(jobDir, 'executor.log'),
      workerLog: path.join(jobDir, 'worker.log'),
      final: path.join(jobDir, 'final.md'),
      patch: path.join(jobDir, 'patch.diff'),
      checksDir: path.join(jobDir, 'checks'),
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
        appendEvent(id, { type: 'status', from: current.status, to: next.status, ...(next.error ? { error: next.error.code } : {}) });
      }
      if ((current.integration ?? 'none') !== next.integration) {
        appendEvent(id, { type: 'integration', to: next.integration });
      }
      return next;
    });
  }

  /** Marks a live job whose worker vanished as failed (worker-lost). */
  async function reconcile(job, now = Date.now()) {
    if (!isLost(job, now)) return job;
    try {
      return await update(job.id, draft => {
        if (!isLost(draft, now)) return draft;
        draft.status = 'failed';
        draft.endedAt = new Date(now).toISOString();
        draft.error = { code: 'worker-lost', message: 'The worker process stopped without finishing the job.' };
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

  function recordWatcher(client) {
    fs.mkdirSync(dir, { recursive: true });
    const record = { seenAt: new Date().toISOString(), client: String(client ?? 'unknown').slice(0, 200) };
    writeJsonAtomic(path.join(dir, 'watcher.json'), record);
    return record;
  }

  function watcher(now = Date.now()) {
    try {
      const record = readJson(path.join(dir, 'watcher.json'));
      const seen = Date.parse(record.seenAt);
      return { active: Number.isFinite(seen) && now - seen <= WATCHER_ACTIVE_MS, lastSeenAt: record.seenAt, client: record.client };
    } catch {
      return { active: false };
    }
  }

  return { root, dir, jobsDir, paths, create, read, list, update, reconcile, appendEvent, withDispatchLock, recordWatcher, watcher };
}
