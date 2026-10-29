// The relay_* tools: the one entrance for every planner, whichever agent it
// is. Each tool takes plain JSON and returns plain JSON; errors carry a code.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, plannerFromName, TIERS } from './config.mjs';
import { describeExecutors } from './executors.mjs';
import { addWorktree, applyPatch, ensureExcluded, removeWorktree, repoRoot, snapshotBase } from './git.mjs';
import { workerSpawnOptions } from './platform.mjs';
import { planDispatch } from './policy.mjs';
import { createStore, isAlive, isJobId, newJobId, TERMINAL } from './store.mjs';

export const VERSION = '0.2.0';
export const MAX_WAIT_SECONDS = 50;
/** A watcher counts as active while it polled this recently. */
export const WATCHER_ACTIVE_MS = 3 * 60_000;

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const POLL_MS = 500;

function fail(code, message, details) {
  return Object.assign(new Error(message), { code }, details === undefined ? {} : { details });
}

const jobIdSchema = { type: 'string', description: 'A job id returned by relay_dispatch, such as j20261029-061530-a1b2c3.' };

export const TOOLS = Object.freeze([
  {
    name: 'relay_agents',
    description:
      'List the executors (codex, claude, dsh; agy and acp are reserved), whether each is installed, which planner you are taken to be, the active profile and why, and the executor, model and effort each tier goes to.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'relay_dispatch',
    description: [
      'Hand a job to another agent. It runs in its own git worktree; your working tree changes only when you call relay_apply.',
      'Tiers: deep = complex or multi-file work (scope required, "." for the whole repository); light = simple, clearly specified work (1-10 scope paths and at least one check command required); review = read-only investigation.',
      'Write a self-contained task: the goal, the relevant files, constraints and how to verify. Checks are shell commands run in the worktree afterwards; exit 0 passes.',
      'If the result says watcher.active, end your turn: you will be woken when the job ends. Otherwise poll with relay_wait.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the executor should do, self-contained.' },
        tier: { type: 'string', enum: [...TIERS] },
        executor: { type: 'string', description: 'Override the profile: codex, claude or dsh.' },
        model: { type: 'string', description: "Model for this job, passed through the executor's own flag (codex -m, claude --model); dsh refuses one." },
        effort: { type: 'string', description: 'Reasoning effort for this job (codex model_reasoning_effort, claude --effort).' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Project-relative files or directories the job may change.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Shell commands that verify the work; run in the worktree after the executor.' },
        title: { type: 'string', description: 'A short label for status lists.' },
        acceptance: { type: 'string', description: 'Acceptance criteria shown to the executor.' },
        timeoutMinutes: { type: 'number', description: "Stop the executor after this many minutes (default: the executor's setting)." },
      },
      required: ['task', 'tier'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_status',
    description: 'Show one job (jobId) or all jobs that are not discarded. watch: true marks this planner session as watched, for a planner-side watcher such as the Claude Code mod.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: jobIdSchema,
        all: { type: 'boolean', description: 'Include discarded jobs.' },
        watch: { type: 'boolean', description: 'Record that a watcher polls this session.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'relay_wait',
    description: `Wait until one of the jobs (default: every running job) ends, for at most ${MAX_WAIT_SECONDS} seconds; call it again while jobs are still running.`,
    inputSchema: {
      type: 'object',
      properties: {
        jobIds: { type: 'array', items: { type: 'string' } },
        timeoutSeconds: { type: 'number', description: `At most ${MAX_WAIT_SECONDS}.` },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'relay_result',
    description: "A finished job's summary, changed files, out-of-scope files, checks, patch stat and log paths. Read it before relay_apply or relay_discard.",
    inputSchema: { type: 'object', properties: { jobId: jobIdSchema }, required: ['jobId'], additionalProperties: false },
  },
  {
    name: 'relay_apply',
    description:
      "Apply a completed job's patch to your working tree (unstaged) and remove its worktree. Out-of-scope changes need allowOutOfScope: true; a failed or cancelled job needs force: true.",
    inputSchema: {
      type: 'object',
      properties: { jobId: jobIdSchema, allowOutOfScope: { type: 'boolean' }, force: { type: 'boolean' } },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_discard',
    description: "Drop a finished job's changes: remove its worktree and branch.",
    inputSchema: { type: 'object', properties: { jobId: jobIdSchema }, required: ['jobId'], additionalProperties: false },
  },
  {
    name: 'relay_cancel',
    description: 'Stop a queued or running job; it ends cancelled and its checks are not run.',
    inputSchema: { type: 'object', properties: { jobId: jobIdSchema }, required: ['jobId'], additionalProperties: false },
  },
]);

/** The repository the hub serves: an explicit root, Claude Code's project dir, or the working directory. */
export async function resolveRoot(cwd, env) {
  return repoRoot(env.AGENTHUB_RELAY_ROOT || env.CLAUDE_PROJECT_DIR || cwd);
}

/** Starts the detached worker process for a job and returns its pid. */
export function startWorkerProcess(root, jobId, env, workerLog) {
  const log = fs.openSync(workerLog, 'a');
  try {
    const child = spawn(process.execPath, [CLI, 'worker', jobId], {
      cwd: root,
      env: { ...env, AGENTHUB_RELAY_ROOT: root },
      ...workerSpawnOptions(),
      stdio: ['ignore', log, log],
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

function summarize(job) {
  return {
    id: job.id,
    title: job.title,
    tier: job.tier,
    executor: job.executor,
    status: job.status,
    integration: job.integration,
    verification: job.verification,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    model: job.model,
    effort: job.effort,
    changedFiles: job.changedFiles?.length,
    outOfScope: job.outOfScope?.length,
    resultFetched: Boolean(job.resultFetchedAt),
    error: job.error?.code,
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(fail('cancelled', 'The request was cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(fail('cancelled', 'The request was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The relay for one planner session.
 *
 * @param {object} options
 * @param {string} [options.cwd] where to look for the repository
 * @param {object} [options.env] environment (AGENTHUB_RELAY_ROLE, credentials to pass by name)
 * @param {Function} [options.startWorker] (root, jobId, env, workerLog) => pid
 * @param {Function} [options.clientName] () => the MCP client's name; it identifies the planner when nothing else does
 * @param {string} [options.planner] the planner's id, as given on the command line
 * @param {number} [options.maxWaitSeconds] the longest relay_wait (MCP clients time out tool calls)
 * @param {string} [options.platform] process.platform; on Windows relay_cancel sends no signal
 */
export function createRelay({
  cwd = process.cwd(),
  env = process.env,
  startWorker = startWorkerProcess,
  clientName = () => 'unknown',
  planner,
  maxWaitSeconds = MAX_WAIT_SECONDS,
  platform = process.platform,
} = {}) {
  let rootPromise;
  let watcherSeenAt;

  /** Who is planning: the explicit id, AGENTHUB_RELAY_PLANNER, or the MCP client's name. */
  function plannerId() {
    return plannerFromName(planner ?? env.AGENTHUB_RELAY_PLANNER ?? clientName());
  }

  function config(r) {
    return loadConfig({ root: r, env, planner: plannerId() });
  }

  async function root() {
    rootPromise ??= resolveRoot(cwd, env).catch(err => {
      rootPromise = undefined;
      throw err;
    });
    return rootPromise;
  }

  function watcher(now = Date.now()) {
    if (watcherSeenAt === undefined) return { active: false };
    return { active: now - watcherSeenAt <= WATCHER_ACTIVE_MS, lastSeenAt: new Date(watcherSeenAt).toISOString() };
  }

  async function readJob(store, jobId) {
    if (!isJobId(jobId)) throw fail('unknown-job', `"${jobId}" is not a job id`);
    return store.reconcile(store.read(jobId));
  }

  async function listJobs(store) {
    return Promise.all(store.list().map(job => store.reconcile(job)));
  }

  const handlers = {
    async relay_agents() {
      const r = await root();
      const settings = config(r);
      return {
        root: r,
        planner: settings.planner,
        profile: settings.profile,
        profileReason: settings.profileReason,
        mapping: settings.mapping,
        routes: settings.routes,
        configFiles: settings.sources,
        tiers: {
          deep: 'Complex or multi-file work; scope required.',
          light: `Simple, clearly specified work; 1-${settings.light.maxScopeEntries} scope paths and at least one check.`,
          review: 'Read-only investigation; any change is reported out of scope.',
        },
        executors: describeExecutors(settings, env),
      };
    },

    async relay_dispatch(args) {
      const r = await root();
      const settings = config(r);
      const store = createStore(r);
      return store.withDispatchLock(async () => {
        const jobs = await listJobs(store);
        const plan = planDispatch({ request: args, config: settings, jobs, role: env.AGENTHUB_RELAY_ROLE });
        const base = await snapshotBase(r);
        await ensureExcluded(r);
        const id = newJobId();
        const { dir, branch } = await addWorktree(r, id, base.commit);
        const warnings = [];
        if (base.untrackedCount > 0) {
          const more = base.untrackedCount > base.untracked.length ? ', …' : '';
          warnings.push(`${base.untrackedCount} untracked file(s) are not in the job's baseline: ${base.untracked.join(', ')}${more}`);
        }
        try {
          store.create({
            id,
            ...plan,
            planner: { client: clientName(), id: settings.planner, profile: settings.profile },
            base,
            worktree: path.relative(r, dir),
            branch,
            passEnv: settings.executors[plan.executor].passEnv,
            warnings,
          });
        } catch (err) {
          await removeWorktree(r, id).catch(() => {});
          throw err;
        }
        let pid;
        try {
          pid = startWorker(r, id, env, store.paths(id).workerLog);
        } catch (err) {
          await store.update(id, draft => {
            draft.status = 'failed';
            draft.endedAt = new Date().toISOString();
            draft.error = { code: 'worker-start-failed', message: err.message };
          });
          throw fail('worker-start-failed', `Could not start the worker: ${err.message}`);
        }
        await store.update(id, draft => {
          draft.worker = { ...(draft.worker ?? {}), pid: draft.worker?.pid ?? pid };
        });
        return {
          jobId: id,
          title: plan.title,
          tier: plan.tier,
          executor: plan.executor,
          model: plan.model,
          effort: plan.effort,
          planner: settings.planner,
          profile: settings.profile,
          scope: plan.scope,
          checks: plan.checks,
          worktree: path.relative(r, dir),
          branch,
          baseCommit: base.commit,
          baseIncludesUncommitted: base.includesUncommitted,
          warnings,
          watcher: watcher(),
        };
      });
    },

    async relay_status(args) {
      if (args.watch === true) watcherSeenAt = Date.now();
      const r = await root();
      const store = createStore(r);
      if (args.jobId !== undefined) return { job: summarize(await readJob(store, args.jobId)), watcher: watcher() };
      const jobs = (await listJobs(store)).filter(job => args.all === true || job.integration !== 'discarded');
      return {
        jobs: jobs.map(summarize),
        running: jobs.filter(job => !TERMINAL.has(job.status)).length,
        watcher: watcher(),
      };
    },

    async relay_wait(args, { signal }) {
      const r = await root();
      const store = createStore(r);
      let seconds = args.timeoutSeconds ?? MAX_WAIT_SECONDS;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        throw fail('invalid-request', 'timeoutSeconds must be a non-negative number');
      }
      seconds = Math.min(seconds, maxWaitSeconds);
      let ids = args.jobIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !isJobId(id)))) {
        throw fail('invalid-request', 'jobIds must be a list of job ids');
      }
      if (!ids?.length) ids = (await listJobs(store)).filter(job => !TERMINAL.has(job.status)).map(job => job.id);
      if (ids.length === 0) return { finished: [], running: [], timedOut: false, note: 'No job is running.' };
      const deadline = Date.now() + seconds * 1000;
      for (;;) {
        const jobs = await Promise.all(ids.map(id => readJob(store, id)));
        const finished = jobs.filter(job => TERMINAL.has(job.status));
        const running = jobs.filter(job => !TERMINAL.has(job.status)).map(job => job.id);
        if (finished.length > 0) return { finished: finished.map(summarize), running, timedOut: false };
        if (Date.now() >= deadline) return { finished: [], running, timedOut: true };
        await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
      }
    },

    async relay_result(args) {
      const r = await root();
      const store = createStore(r);
      let job = await readJob(store, args.jobId);
      if (TERMINAL.has(job.status) && !job.resultFetchedAt) {
        job = await store.update(job.id, draft => {
          draft.resultFetchedAt = new Date().toISOString();
        });
      }
      const p = store.paths(job.id);
      const rel = file => path.relative(r, file);
      const checkLogs = job.checkResults?.filter(check => check.log).map(check => rel(check.log)) ?? [];
      return {
        ...summarize(job),
        scope: job.scope,
        base: job.base,
        worktree: job.worktree,
        branch: job.branch,
        summary: job.summary,
        checks: job.checkResults?.map(({ log, ...check }) => check) ?? [],
        changedFiles: job.changedFiles ?? [],
        outOfScope: job.outOfScope ?? [],
        patchStat: job.patchStat,
        warnings: job.warnings ?? [],
        executorRun: job.executorRun,
        error: job.error,
        logs: { executor: rel(p.executorLog), worker: rel(p.workerLog), final: rel(p.final), patch: rel(p.patch), checks: checkLogs },
      };
    },

    async relay_apply(args) {
      const r = await root();
      const store = createStore(r);
      const job = await readJob(store, args.jobId);
      if (!TERMINAL.has(job.status)) throw fail('job-running', `Job ${job.id} is still ${job.status}`);
      if (job.integration !== 'none') throw fail('already-integrated', `Job ${job.id} was already ${job.integration}`);
      if (!job.write) throw fail('read-only-job', `Job ${job.id} is a read-only review; discard it instead`);
      if (job.status !== 'completed' && args.force !== true) {
        throw fail('job-not-completed', `Job ${job.id} ended ${job.status}; pass force: true to apply it anyway`);
      }
      if ((job.outOfScope ?? []).length > 0 && args.allowOutOfScope !== true) {
        throw fail('out-of-scope', `Job ${job.id} changed files outside its scope: ${job.outOfScope.join(', ')}; pass allowOutOfScope: true to apply them`, {
          outOfScope: job.outOfScope,
        });
      }
      await applyPatch(r, store.paths(job.id).patch);
      // The patch is in the working tree now: record that before cleanup,
      // so a failed cleanup cannot make the job look unapplied.
      await store.update(job.id, draft => {
        draft.integration = 'applied';
        draft.appliedAt = new Date().toISOString();
      });
      let worktreeRemoved = true;
      try {
        await removeWorktree(r, job.id);
      } catch {
        worktreeRemoved = false;
      }
      return {
        jobId: job.id,
        applied: true,
        files: job.changedFiles ?? [],
        worktreeRemoved,
        note: 'The changes are in your working tree, unstaged. Review and commit them.',
      };
    },

    async relay_discard(args) {
      const r = await root();
      const store = createStore(r);
      const job = await readJob(store, args.jobId);
      if (!TERMINAL.has(job.status)) throw fail('job-running', `Job ${job.id} is still ${job.status}; cancel it first`);
      if (job.integration !== 'none') throw fail('already-integrated', `Job ${job.id} was already ${job.integration}`);
      await removeWorktree(r, job.id);
      await store.update(job.id, draft => {
        draft.integration = 'discarded';
        draft.discardedAt = new Date().toISOString();
      });
      return { jobId: job.id, discarded: true };
    },

    async relay_cancel(args) {
      const r = await root();
      const store = createStore(r);
      const job = await readJob(store, args.jobId);
      if (TERMINAL.has(job.status)) throw fail('job-finished', `Job ${job.id} already ended ${job.status}`);
      // The worker ends the job itself: on SIGTERM, at startup or at its next
      // heartbeat. A job whose worker is gone is reconciled to cancelled.
      const flagged = await store.update(job.id, draft => {
        draft.cancelRequested = true;
      });
      const pid = flagged.worker?.pid;
      // On Windows a signal would end the worker at once, before it can stop
      // its executor's tree and record the outcome: the flag alone is enough,
      // since the worker reads it every second.
      if (pid && isAlive(pid) && platform === 'win32') {
        return { jobId: job.id, cancelling: true, note: 'The worker sees the request within a second, stops the executor and ends the job cancelled.' };
      }
      if (pid && isAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // the heartbeat sees the flag
        }
        return { jobId: job.id, cancelling: true, note: 'The worker is stopping the executor; the job ends cancelled.' };
      }
      const ended = await store.reconcile(store.read(job.id));
      return { jobId: job.id, cancelling: !TERMINAL.has(ended.status), status: ended.status };
    },
  };

  async function call(name, args, { signal } = {}) {
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (!handler) throw fail('unknown-tool', `Unknown tool "${name}"`);
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      throw fail('invalid-request', 'Tool arguments must be an object');
    }
    return handler(args ?? {}, { signal });
  }

  return { tools: TOOLS, call, watcher };
}
