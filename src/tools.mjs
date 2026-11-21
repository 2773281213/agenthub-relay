// The relay_* tools: the one entrance for every planner, whichever agent it
// is. Each tool takes plain JSON and returns plain JSON; errors carry a code.
//
// A job is a conversation with one executor in its own worktree: dispatch
// starts it, send continues the same native session, takeover hands it to a
// person in the executor's own app or terminal, and collect hands it back to
// be checked again. Apply and discard end it.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  configLayers, configPath, EXECUTOR_IDS, loadConfig, parseRoute, PLANNER_IDS, plannerFromName, RESERVED, TIERS, userConfigPath, writeSettings,
} from './config.mjs';
import { executorCommand } from './discovery.mjs';
import { adapterFor, describeExecutors, displayCommand, SESSION_ID } from './executors.mjs';
import { addWorktree, applyPatch, ensureExcluded, patchIsApplied, removeWorktree, repoRoot, snapshotBase } from './git.mjs';
import { ACCEPTED, agentDefaults, assertRoute, catalogFor, checkRoute, MODEL_AGENTS } from './models.mjs';
import { openDetached, workerSpawnOptions } from './platform.mjs';
import { holdsScope, isExecutorCaller, planDispatch, planSend, scopeConflict } from './policy.mjs';
import { createSessionStore, describeTiers, isSessionId, newSessionId, plainRoute, routeText } from './session.mjs';
import {
  createStore, isAbandonedReservation, isAlive, isJobId, LIVE, newJobId, RESERVATIONS, TERMINAL, turnNumber, turnsOf,
} from './store.mjs';

export const VERSION = '0.5.0';
export const MAX_WAIT_SECONDS = 50;
/** A watcher counts as active while it polled this recently. */
export const WATCHER_ACTIVE_MS = 3 * 60_000;
/** How long send with interrupt, and takeover with stop, wait for the running turn to end. */
export const STOP_WAIT_MS = 30_000;

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const POLL_MS = 500;
const MAX_LISTED_MESSAGE_CHARS = 500;

function fail(code, message, details) {
  return Object.assign(new Error(message), { code }, details === undefined ? {} : { details });
}

const jobIdSchema = { type: 'string', description: 'A job id returned by relay_dispatch, such as j20261029-061530-a1b2c3.' };

const routeSchema = { type: 'string', description: 'executor[:model][@effort], for example claude:opus@high, codex:gpt-5.1-codex@medium or dsh.' };

const sessionSchema = { type: 'string', description: "The confirmed session id; defaults to this connection's session." };

export const TOOLS = Object.freeze([
  {
    name: 'relay_agents',
    description:
      'List the executors (codex, claude, dsh, agy; acp is reserved), whether each is installed (found on PATH or in its usual install folder), which planner you are taken to be, the active profile and why, the executor, model and effort each tier goes to, each agent\'s own default model, and the current planner session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'relay_session',
    description: [
      'Planner sessions. At the start of every planner session call action "start": it lists the saved roles (the executor, model and effort of the deep, light and review tiers), each agent\'s own default model and the check of each model.',
      'Show that to the user and ask whether to keep it or change it; never answer for the user.',
      'Then call action "confirm" with reuse: true, or with the tiers the user chose (deep, light, review as executor[:model][@effort]); changes are checked against each agent\'s model list and saved for later sessions (user: true saves them for every project).',
      'Dispatch works only inside a confirmed session. Action "show" shows the current session.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'confirm', 'show'] },
        planner: { type: 'string', enum: [...PLANNER_IDS], description: 'Who is planning, when your client name does not say it (start).' },
        session: { type: 'string', description: 'The session id start returned (confirm, show); defaults to this connection\'s session.' },
        reuse: { type: 'boolean', description: 'Keep the saved roles (confirm).' },
        deep: routeSchema,
        light: routeSchema,
        review: routeSchema,
        user: { type: 'boolean', description: 'Save changed roles in the user configuration file instead of the project\'s (confirm).' },
        refresh: { type: 'boolean', description: 'Fetch the model lists again instead of using the cached ones (start).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_models',
    description: 'The models each agent offers (codex: its app-server model list with the reasoning efforts of each model; claude: its documented aliases, plus the API list when ANTHROPIC_API_KEY is set; dsh: the models of its configured providers) and the model and effort each agent uses by default, read from its own settings. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: [...MODEL_AGENTS] },
        refresh: { type: 'boolean', description: 'Fetch again instead of using a cached list.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'relay_dispatch',
    description: [
      'Hand a job to another agent, inside a planner session confirmed with relay_session. It runs in its own git worktree; your working tree changes only when you call relay_apply.',
      'Tiers: deep = complex or multi-file work (scope required, "." for the whole repository); light = simple, clearly specified work (1-10 scope paths and at least one check command required); review = read-only investigation.',
      'Write a self-contained task: the goal, the relevant files, constraints and how to verify. Checks are shell commands run in the worktree afterwards; exit 0 passes.',
      'If the result says watcher.active, end your turn: you will be woken when the job ends. Otherwise poll with relay_wait. The result\'s next lists what you can do from here.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the executor should do, self-contained.' },
        tier: { type: 'string', enum: [...TIERS] },
        session: sessionSchema,
        executor: { type: 'string', description: 'Override the session\'s route: codex, claude, dsh or agy.' },
        model: { type: 'string', description: "Model for this job, checked and passed through the executor's own flag (codex -m, claude --model, agy --model); dsh uses its own settings and refuses one." },
        effort: { type: 'string', description: 'Reasoning effort for this job (codex model_reasoning_effort, claude --effort, agy --effort).' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Project-relative files or directories the job may change.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Shell commands that verify the work; run in the worktree after the executor, and again after every later turn.' },
        title: { type: 'string', description: 'A short label for status lists.' },
        acceptance: { type: 'string', description: 'Acceptance criteria shown to the executor.' },
        timeoutMinutes: { type: 'number', description: "Stop the executor after this many minutes, each turn (default: the executor's setting)." },
      },
      required: ['task', 'tier'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_send',
    description: [
      "Continue a finished job in the same executor session, in the same worktree: ask for fixes after reviewing it, answer a question its summary asked, or resume one that was interrupted (a timeout, a lost worker, a reboot).",
      'The executor keeps its context; its checks run again and the patch is the whole change since the job began. A running job needs interrupt: true, which stops the current turn first (nothing is sent if it does not stop within 30 seconds).',
      'Refused once the job is applied or discarded, while it is taken over (relay_collect first), or when the executor left no session to continue.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        jobId: jobIdSchema,
        message: { type: 'string', description: 'What to tell the executor, self-contained for this turn.' },
        interrupt: { type: 'boolean', description: 'Stop a running turn first, then send.' },
        force: { type: 'boolean', description: 'Send to a taken-over job anyway (ends the takeover).' },
        session: sessionSchema,
      },
      required: ['jobId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_takeover',
    description: [
      "Hand a job to a person: returns how to open its executor's own session in the job's worktree, in the executor's desktop app where it has one (Claude Code: the Claude desktop app; Codex: a codex:// link) and in a terminal.",
      'open: true opens the app. A running job needs stop: true, which stops its headless turn first. While a job is taken over the relay sends it nothing; hand it back with relay_collect when the person is done, so its checks run and its patch is collected again.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        jobId: jobIdSchema,
        stop: { type: 'boolean', description: 'Stop a running turn first.' },
        open: { type: 'boolean', description: "Open the session in the executor's desktop app now." },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_collect',
    description: 'Hand a job back after a takeover (or collect its changes again after a collection failed): runs its checks and collects the patch from its worktree in the background, as a new turn without the executor. Wait for it like any job.',
    inputSchema: { type: 'object', properties: { jobId: jobIdSchema, session: sessionSchema }, required: ['jobId'], additionalProperties: false },
  },
  {
    name: 'relay_status',
    description: 'Show one job (jobId) or all jobs that are not discarded, with their turn and what can be done next. watch: true marks this planner session as watched, for a planner-side watcher such as the Claude Code mod.',
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
    description: "A finished job's summary, changed files, out-of-scope files, checks, patch stat, its turns, its executor session and log paths, and what to do next. Read it before relay_apply, relay_send or relay_discard.",
    inputSchema: { type: 'object', properties: { jobId: jobIdSchema }, required: ['jobId'], additionalProperties: false },
  },
  {
    name: 'relay_apply',
    description:
      "Apply a completed job's patch to your working tree (unstaged) and remove its worktree. Out-of-scope changes need allowOutOfScope: true; a failed or cancelled job needs force: true; a taken-over job must be handed back with relay_collect first.",
    inputSchema: {
      type: 'object',
      properties: { jobId: jobIdSchema, allowOutOfScope: { type: 'boolean' }, force: { type: 'boolean' } },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_discard',
    description: "Drop a finished job's changes: remove its worktree and branch. A taken-over job needs force: true, since a person may still be working in it.",
    inputSchema: { type: 'object', properties: { jobId: jobIdSchema, force: { type: 'boolean' } }, required: ['jobId'], additionalProperties: false },
  },
  {
    name: 'relay_cancel',
    description: 'Stop a queued or running job; it ends cancelled and its checks are not run. Its executor session and worktree stay, so relay_send can continue it later.',
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

/** Whether the latest turn's result has been read with relay_result. */
export function resultFetched(job) {
  if (Number.isInteger(job.resultFetchedTurn)) return job.resultFetchedTurn >= turnNumber(job);
  // A record from before turns: read once is read.
  return !Array.isArray(job.turns) && Boolean(job.resultFetchedAt);
}

/** Token and cost figures summed over the job's turns, when its executor reports them per run. */
function usageTotals(job) {
  const totals = {};
  for (const turn of turnsOf(job)) {
    for (const [key, value] of Object.entries(turn.usage ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  if (totals.costUsd !== undefined) totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return Object.keys(totals).length ? totals : undefined;
}

function summarize(job) {
  const usage = usageTotals(job);
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
    ...(job.session ? { session: job.session } : {}),
    turn: turnNumber(job),
    ...(job.takeover ? { takenOver: true } : {}),
    resumable: Boolean(job.native?.sessionId),
    changedFiles: job.changedFiles?.length,
    outOfScope: job.outOfScope?.length,
    resultFetched: resultFetched(job),
    ...(usage ? { usage } : {}),
    error: job.error?.code,
  };
}

function hint(tool, cli, why) {
  return { ...(tool ? { tool } : {}), ...(cli ? { cli } : {}), why };
}

/**
 * What a planner can do with a job from here, most useful first: each with
 * the relay_* tool, the same command for the bundled CLI, and why.
 */
export function nextFor(job, { watcherActive = false } = {}) {
  const id = job.id;
  const integration = job.integration ?? 'none';
  if (integration === 'applied' || integration === 'discarded') return [];
  if (RESERVATIONS.has(integration)) return [hint('relay_status', `status ${id}`, `an ${integration === 'applying' ? 'apply' : 'discard'} is in progress`)];
  if (LIVE.has(job.status)) {
    return [
      watcherActive
        ? hint(null, null, 'end your turn: you are woken when the job ends')
        : hint('relay_wait', `wait ${id}`, 'wait for this turn to end'),
      hint('relay_send', `send ${id} --interrupt --message-file -`, 'stop this turn and redirect the same session'),
      hint('relay_takeover', `takeover ${id} --stop`, "stop it and continue it yourself in the executor's own app"),
      hint('relay_cancel', `cancel ${id}`, 'stop it; its session stays for a later send'),
    ];
  }
  if (job.takeover) {
    return [
      hint('relay_collect', `collect ${id}`, 'hand it back once the interactive session is closed: its checks run and its patch is collected again'),
      hint('relay_discard', `discard ${id} --force`, 'drop it and its worktree'),
    ];
  }
  const next = [];
  if (!resultFetched(job)) next.push(hint('relay_result', `result ${id}`, 'read the summary, checks and changes first'));
  if (job.write && job.status === 'completed') next.push(hint('relay_apply', `apply ${id}`, 'apply the patch to your working tree'));
  if (job.native?.sessionId) next.push(hint('relay_send', `send ${id} --message-file -`, 'ask the same session for changes, or to continue; it keeps its context'));
  if (job.native?.sessionId) next.push(hint('relay_takeover', `takeover ${id}`, "continue it yourself in the executor's own app or terminal"));
  next.push(hint('relay_discard', `discard ${id}`, 'drop it'));
  return next;
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

/** A path relative to the repository, with forward slashes on every platform (records and results read the same everywhere). */
function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function clipText(text, max) {
  return typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : text;
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
 * @param {Function} [options.open] how a takeover opens its target (platform.openDetached)
 */
export function createRelay({
  cwd = process.cwd(),
  env = process.env,
  startWorker = startWorkerProcess,
  clientName = () => 'unknown',
  planner,
  maxWaitSeconds = MAX_WAIT_SECONDS,
  platform = process.platform,
  open = openDetached,
} = {}) {
  let rootPromise;
  let watcherSeenAt;
  /** This connection's planner session: the last one started, and the last one confirmed. */
  let startedSessionId;
  let currentSessionId;

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

  function refuseExecutor(what) {
    if (isExecutorCaller(env)) {
      throw fail('executor-role', `This process runs as an agenthub-relay executor (AGENTHUB_RELAY_ROLE=executor); executors may not ${what}.`);
    }
  }

  /**
   * An apply or discard whose process died mid-way: an apply whose patch is
   * wholly in the working tree is recorded as applied, otherwise the job is
   * unintegrated again; a discard is finished.
   */
  async function recoverReservation(r, store, job) {
    const p = store.paths(job.id);
    const at = new Date().toISOString();
    if (job.integration === 'applying') {
      const applied = await patchIsApplied(r, p.patch).catch(() => false);
      const updated = await store.update(job.id, draft => {
        if (draft.integration !== 'applying' || !isAbandonedReservation(draft)) return draft;
        draft.integration = applied ? 'applied' : 'none';
        if (applied) draft.appliedAt = at;
        delete draft.integrationPid;
        delete draft.integrationAt;
        draft.warnings = [
          ...(draft.warnings ?? []),
          applied
            ? 'An apply was interrupted after its patch reached the working tree; it is recorded as applied.'
            : 'An apply was interrupted before its patch reached the working tree; the job is unintegrated again.',
        ];
        return draft;
      }).catch(() => store.read(job.id));
      if (updated.integration === 'applied') await removeWorktree(r, job.id).catch(() => {});
      return updated;
    }
    await removeWorktree(r, job.id).catch(() => {});
    return store.update(job.id, draft => {
      if (draft.integration !== 'discarding' || !isAbandonedReservation(draft)) return draft;
      draft.integration = 'discarded';
      draft.discardedAt = at;
      delete draft.integrationPid;
      delete draft.integrationAt;
      return draft;
    }).catch(() => store.read(job.id));
  }

  async function reconcileJob(r, store, job) {
    let current = await store.reconcile(job);
    if (isAbandonedReservation(current)) current = await recoverReservation(r, store, current);
    return current;
  }

  async function readJob(store, jobId) {
    if (!isJobId(jobId)) throw fail('unknown-job', `"${jobId}" is not a job id`);
    return reconcileJob(store.root, store, store.read(jobId));
  }

  async function listJobs(store) {
    return Promise.all(store.list().map(job => reconcileJob(store.root, store, job)));
  }

  function sessionFor(r, sessionId) {
    if (sessionId !== undefined && !isSessionId(sessionId)) throw fail('unknown-session', `"${sessionId}" is not a session id`);
    const id = sessionId ?? currentSessionId;
    return id ? createSessionStore(r).read(id) : null;
  }

  /** A session id the executor printed in a log, for a job whose record has none (a run from before 0.5). */
  function sessionFromLogs(store, job) {
    let adapter;
    try {
      adapter = adapterFor(job.executor);
    } catch {
      return undefined;
    }
    const p = store.paths(job.id);
    const logs = [...turnsOf(job)].reverse().map(turn => p.turn(turn.n).executorLog).concat([p.executorLog]);
    for (const log of logs) {
      let text;
      try {
        text = fs.readFileSync(log, 'utf8');
      } catch {
        continue;
      }
      let found;
      for (const line of text.split('\n')) {
        const id = adapter.sessionFromLine(line);
        if (id && SESSION_ID.test(id)) found = id;
      }
      if (found) return found;
    }
    return job.executorRun?.sessionId && SESSION_ID.test(job.executorRun.sessionId) ? job.executorRun.sessionId : undefined;
  }

  /** Asks a job's worker to stop its turn (the flag, plus SIGTERM where signals reach it). */
  async function requestCancel(store, jobId) {
    const flagged = await store.update(jobId, draft => {
      draft.cancelRequested = true;
    });
    const pid = flagged.worker?.pid;
    // On Windows a signal would end the worker at once, before it can stop
    // its executor's tree and record the outcome: the flag alone is enough,
    // since the worker reads it every second.
    if (pid && isAlive(pid) && platform !== 'win32') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // the heartbeat sees the flag
      }
    }
    return flagged;
  }

  async function waitForEnd(store, jobId, ms, signal) {
    const deadline = Date.now() + ms;
    for (;;) {
      const job = await readJob(store, jobId);
      if (TERMINAL.has(job.status) || Date.now() >= deadline) return job;
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
    }
  }

  /**
   * Queues the next turn of a finished job and starts its worker. The state
   * change is one update under the job's lock, so of two callers racing for
   * the same job only one gets it; the other is told the job is busy.
   */
  async function queueTurn(r, store, jobId, entry, { endTakeover = false } = {}) {
    const queuedAt = new Date().toISOString();
    const queued = await store.update(jobId, draft => {
      if (!TERMINAL.has(draft.status)) throw fail('job-busy', `Job ${jobId} is ${draft.status}: another turn got there first`);
      const integration = draft.integration ?? 'none';
      if (integration !== 'none') {
        throw fail(RESERVATIONS.has(integration) ? 'job-busy' : 'already-integrated', `Job ${jobId} is ${integration}; it takes no more turns`);
      }
      draft.turns = turnsOf(draft).map(turn => ({ ...turn }));
      const n = draft.turns.at(-1).n + 1;
      draft.turns.push({ n, ...entry, status: 'queued', queuedAt });
      draft.status = 'queued';
      // A new turn starts clean: an old cancel must not stop it, an old error
      // must not describe it, and its liveness is counted from now, not from
      // the last turn's heartbeat and worker.
      delete draft.cancelRequested;
      delete draft.error;
      delete draft.endedAt;
      delete draft.startedAt;
      draft.heartbeatAt = queuedAt;
      draft.worker = {};
      if (endTakeover) delete draft.takeover;
      return draft;
    });
    const n = queued.turns.at(-1).n;
    let pid;
    try {
      pid = startWorker(r, jobId, env, store.paths(jobId).workerLog);
    } catch (err) {
      await store.update(jobId, draft => {
        draft.status = 'failed';
        draft.endedAt = new Date().toISOString();
        draft.error = { code: 'worker-start-failed', message: err.message };
        Object.assign(draft.turns.at(-1), { status: 'failed', endedAt: draft.endedAt, error: 'worker-start-failed' });
      });
      throw fail('worker-start-failed', `Could not start the worker: ${err.message}`);
    }
    const job = await store.update(jobId, draft => {
      draft.worker = { ...(draft.worker ?? {}), pid: draft.worker?.pid ?? pid };
    });
    return { job, turn: n };
  }

  /** Catalog entries for the agents named (default: all), fetching lists only when `fetch`. */
  async function catalogs(r, settings, { agents = MODEL_AGENTS, fetch = true, refresh = false } = {}) {
    const entries = await Promise.all(
      [...new Set(agents)].map(agent => catalogFor(agent, { env, root: r, config: settings, fetch, refresh, platform, clientVersion: VERSION })),
    );
    return Object.fromEntries(entries.map(entry => [entry.agent, entry]));
  }

  /** What the planner shows the user about each agent's models. */
  function catalogSummary(entries) {
    return Object.fromEntries(Object.values(entries).filter(entry => !entry.reserved).map(entry => [entry.agent, {
      models: entry.models.map(m => (m.efforts?.length ? `${m.id} (${m.efforts.join('/')})${m.isDefault ? ' default' : ''}` : m.provider ? `${m.id} (${m.provider})` : m.id)),
      source: entry.source,
      default: entry.default,
      ...(entry.fetchedAt ? { fetchedAt: entry.fetchedAt } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.apiError ? { apiError: entry.apiError } : {}),
      ...(entry.note ? { note: entry.note } : {}),
    }]));
  }

  function plainRoutes(routes) {
    return Object.fromEntries(TIERS.map(tier => [tier, plainRoute(routes[tier])]));
  }

  function sessionSummary(record) {
    if (!record) return null;
    return {
      session: record.id,
      status: record.status,
      planner: record.planner,
      createdAt: record.createdAt,
      ...(record.confirmedAt ? { confirmedAt: record.confirmedAt, source: record.source } : {}),
      routes: Object.fromEntries(Object.entries(record.routes ?? record.proposed ?? {}).map(([tier, route]) => [tier, routeText(route)])),
    };
  }

  function currentSession(r) {
    if (!currentSessionId) return null;
    try {
      return createSessionStore(r).read(currentSessionId);
    } catch {
      return null;
    }
  }

  async function startSession(r, args) {
    if (args.planner !== undefined && !PLANNER_IDS.includes(args.planner)) {
      throw fail('invalid-request', `planner must be one of ${PLANNER_IDS.join(', ')}`);
    }
    const id = args.planner ?? plannerId();
    if (id === 'unknown') {
      throw fail('planner-unknown', `Say which agent is planning: pass --planner <${PLANNER_IDS.join('|')}> (planner in relay_session).`);
    }
    const settings = loadConfig({ root: r, env, planner: id });
    await ensureExcluded(r);
    const entries = await catalogs(r, settings, { refresh: args.refresh === true });
    const sessions = createSessionStore(r);
    const last = sessions.lastConfirmed();
    const record = sessions.create({
      id: newSessionId(),
      planner: id,
      client: clientName(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      profile: settings.profile,
      profileReason: settings.profileReason,
      proposed: plainRoutes(settings.routes),
    });
    startedSessionId = record.id;
    return {
      session: record.id,
      status: 'needs-confirmation',
      planner: id,
      lastPlanner: last ? { planner: last.planner, confirmedAt: last.confirmedAt } : null,
      profile: settings.profile,
      profileReason: settings.profileReason,
      configFiles: settings.sources,
      tiers: describeTiers({ routes: settings.routes, config: settings, catalogs: entries, check: checkRoute }),
      agents: catalogSummary(entries),
      instruction:
        'Show the user these saved roles: for deep, light and review the executor, model and effort (and the check of each), and each agent\'s own default model. Ask whether to keep them or change them, and wait for the answer; do not decide for the user. Then confirm with reuse, or with the tiers the user chose.',
      confirm: {
        reuse: `session confirm ${record.id} --reuse`,
        change: `session confirm ${record.id} [--deep executor[:model][@effort]] [--light ...] [--review ...] [--user]`,
      },
    };
  }

  async function confirmSession(r, args) {
    const sessionId = args.session ?? startedSessionId;
    if (sessionId === undefined) throw fail('invalid-request', 'confirm needs the session id that start returned');
    const sessions = createSessionStore(r);
    const record = sessions.read(sessionId);
    if (record.status === 'confirmed') {
      throw fail('session-confirmed', `Session ${record.id} is already confirmed; start a new session to change its roles`);
    }
    const caller = plannerId();
    if (caller !== 'unknown' && caller !== record.planner) {
      throw fail('planner-mismatch', `Session ${record.id} was started by the ${record.planner} planner, not ${caller}`, { session: record.id, planner: record.planner, caller });
    }
    const changes = Object.fromEntries(TIERS.filter(tier => args[tier] !== undefined).map(tier => [tier, args[tier]]));
    const reuse = args.reuse === true;
    if (reuse && Object.keys(changes).length) throw fail('invalid-request', 'Give reuse or tier changes, not both');
    if (!reuse && Object.keys(changes).length === 0) throw fail('invalid-request', 'confirm needs reuse: true, or at least one of deep, light and review');

    let settings = loadConfig({ root: r, env, planner: record.planner });
    let written = null;
    const warnings = [];
    if (!reuse) {
      const wanted = {};
      for (const [tier, text] of Object.entries(changes)) {
        let route;
        try {
          route = plainRoute(parseRoute(text));
        } catch (err) {
          throw fail('invalid-value', `${tier}: ${err.message}`);
        }
        if (!EXECUTOR_IDS.includes(route.executor)) {
          throw fail('unknown-executor', `${tier}: unknown executor "${route.executor}" (known: ${EXECUTOR_IDS.join(', ')})`);
        }
        wanted[tier] = route;
      }
      const agents = Object.values(wanted).map(route => route.executor).filter(agent => MODEL_AGENTS.includes(agent));
      const entries = await catalogs(r, settings, { agents });
      const failures = [];
      for (const [tier, route] of Object.entries(wanted)) {
        const check = RESERVED[route.executor]
          ? { status: 'unsupported', code: 'reserved-executor', reason: RESERVED[route.executor] }
          : checkRoute(route, entries[route.executor]);
        if (!ACCEPTED.has(check.status)) failures.push({ tier, route: routeText(route), ...check });
      }
      if (failures.length) {
        throw fail(failures[0].code ?? 'model-unknown', `Nothing was saved. ${failures.map(f => `${f.tier} ${f.route}: ${f.reason}`).join('; ')}`, { failures });
      }
      const file = args.user === true ? userConfigPath(env) : configPath(r, env);
      if (!file) throw fail('no-user-config', 'There is no home directory for a user configuration file');
      const layersBelow = args.user === true ? [] : configLayers({ env }).filter(layer => layer.file !== file);
      const profile = settings.plannerProfiles[record.planner] ?? `${record.planner}-planner`;
      const routes = { ...plainRoutes(settings.routes), ...wanted };
      writeSettings({
        file,
        layersBelow,
        entries: [
          ...TIERS.map(tier => ({ key: `profiles.${profile}.${tier}`, value: routeText(routes[tier]) })),
          { key: `plannerProfiles.${record.planner}`, value: profile },
        ],
      });
      written = file;
      settings = loadConfig({ root: r, env, planner: record.planner });
      for (const [tier, route] of Object.entries(wanted)) {
        const applied = routeText(plainRoute(settings.routes[tier]));
        if (applied !== routeText(route)) {
          warnings.push(`${tier}: ${routeText(route)} was saved in ${file}, but ${applied} applies (${settings.profileReason}); this session uses what applies.`);
        }
      }
    }
    const routes = plainRoutes(settings.routes);
    const entries = await catalogs(r, settings, { fetch: false });
    const confirmed = sessions.update(record.id, draft => {
      draft.status = 'confirmed';
      draft.confirmedAt = new Date().toISOString();
      draft.source = reuse ? 'reuse' : 'changed';
      draft.profile = settings.profile;
      draft.routes = routes;
      if (written) draft.configFile = written;
    });
    currentSessionId = confirmed.id;
    return {
      session: confirmed.id,
      status: 'confirmed',
      planner: confirmed.planner,
      source: confirmed.source,
      profile: settings.profile,
      tiers: describeTiers({ routes, config: settings, catalogs: entries, check: checkRoute }),
      written,
      warnings,
      note: `Dispatch with this session: --session ${confirmed.id} on the command line (or AGENTHUB_RELAY_SESSION); MCP clients need nothing more on this connection.`,
    };
  }

  const handlers = {
    async relay_agents() {
      const r = await root();
      const settings = config(r);
      const defaults = agentDefaults({ env, root: r });
      return {
        root: r,
        planner: settings.planner,
        profile: settings.profile,
        profileReason: settings.profileReason,
        mapping: settings.mapping,
        routes: settings.routes,
        configFiles: settings.sources,
        sessionsRequired: settings.sessions.required,
        session: sessionSummary(currentSession(r)),
        tiers: {
          deep: 'Complex or multi-file work; scope required.',
          light: `Simple, clearly specified work; 1-${settings.light.maxScopeEntries} scope paths and at least one check.`,
          review: 'Read-only investigation; any change is reported out of scope.',
        },
        executors: describeExecutors(settings, env, defaults, { platform }),
      };
    },

    async relay_session(args) {
      if (!['start', 'confirm', 'show'].includes(args.action)) throw fail('invalid-request', 'action must be start, confirm or show');
      const r = await root();
      if (args.action === 'show') {
        const sessions = createSessionStore(r);
        if (args.session !== undefined && !isSessionId(args.session)) throw fail('unknown-session', `"${args.session}" is not a session id`);
        const id = args.session ?? currentSessionId ?? startedSessionId;
        const last = sessions.lastConfirmed();
        return {
          session: id ? sessionSummary(sessions.read(id)) : null,
          sessionsRequired: config(r).sessions.required,
          lastPlanner: last ? { planner: last.planner, confirmedAt: last.confirmedAt } : null,
        };
      }
      if (isExecutorCaller(env)) {
        throw fail('executor-role', 'An agenthub-relay executor may not start or confirm planner sessions.');
      }
      if (args.session !== undefined && !isSessionId(args.session)) throw fail('unknown-session', `"${args.session}" is not a session id`);
      return args.action === 'start' ? startSession(r, args) : confirmSession(r, args);
    },

    async relay_models(args) {
      if (args.agent !== undefined && !MODEL_AGENTS.includes(args.agent)) {
        throw fail('unknown-agent', `agent must be one of ${MODEL_AGENTS.join(', ')}`);
      }
      const r = await root();
      const settings = config(r);
      const entries = await catalogs(r, settings, { agents: args.agent ? [args.agent] : MODEL_AGENTS, refresh: args.refresh === true });
      return { agents: entries };
    },

    async relay_dispatch(args) {
      const r = await root();
      const settings = config(r);
      const store = createStore(r);
      const session = sessionFor(r, args.session);
      const caller = plannerId();
      const { session: _session, ...request } = args;
      return store.withDispatchLock(async () => {
        const jobs = await listJobs(store);
        const plan = planDispatch({
          request,
          config: settings,
          jobs,
          role: env.AGENTHUB_RELAY_ROLE,
          session,
          caller,
          agentDefaults: agentDefaults({ env, root: r }),
        });
        if (request.model !== undefined || request.effort !== undefined) {
          // A model or effort named for this job is checked like a saved one.
          const entry = await catalogFor(plan.executor, { env, root: r, config: settings, platform, clientVersion: VERSION });
          assertRoute({ executor: plan.executor, model: plan.model, effort: plan.effort }, entry, `${plan.tier} job on ${plan.executor}`);
        }
        const base = await snapshotBase(r);
        await ensureExcluded(r);
        const id = newJobId();
        const { dir, branch } = await addWorktree(r, id, base.commit);
        const warnings = [];
        if (base.untrackedCount > 0) {
          const more = base.untrackedCount > base.untracked.length ? ', …' : '';
          warnings.push(`${base.untrackedCount} untracked file(s) are not in the job's baseline: ${base.untracked.join(', ')}${more}`);
        }
        const createdAt = new Date().toISOString();
        try {
          store.create({
            id,
            ...plan,
            planner: {
              client: clientName(),
              id: caller === 'unknown' && session ? session.planner : caller,
              ...(caller === 'unknown' && session ? { assumed: true } : {}),
              profile: session?.profile ?? settings.profile,
            },
            ...(session ? { session: session.id } : {}),
            base,
            worktree: relativePath(r, dir),
            branch,
            passEnv: settings.executors[plan.executor].passEnv,
            createdAt,
            turns: [{ n: 1, kind: 'dispatch', by: 'planner', status: 'queued', queuedAt: createdAt }],
            // Claude Code takes the session id it is to use, so a takeover or
            // a follow-up knows it before the first turn has ended.
            native: plan.executor === 'claude' ? { sessionId: crypto.randomUUID() } : {},
            baseWarnings: warnings,
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
            Object.assign(draft.turns.at(-1), { status: 'failed', endedAt: draft.endedAt, error: 'worker-start-failed' });
          });
          throw fail('worker-start-failed', `Could not start the worker: ${err.message}`);
        }
        const job = await store.update(id, draft => {
          draft.worker = { ...(draft.worker ?? {}), pid: draft.worker?.pid ?? pid };
        });
        const watching = watcher();
        return {
          jobId: id,
          title: plan.title,
          tier: plan.tier,
          executor: plan.executor,
          model: plan.model,
          effort: plan.effort,
          planner: caller === 'unknown' && session ? session.planner : caller,
          profile: session?.profile ?? settings.profile,
          session: session?.id ?? null,
          scope: plan.scope,
          checks: plan.checks,
          worktree: relativePath(r, dir),
          branch,
          baseCommit: base.commit,
          baseIncludesUncommitted: base.includesUncommitted,
          warnings,
          watcher: watching,
          next: nextFor(job, { watcherActive: watching.active }),
        };
      });
    },

    async relay_send(args, { signal }) {
      refuseExecutor('send to jobs');
      if (typeof args.message !== 'string' || args.message.trim() === '') throw fail('invalid-request', 'message must be a non-empty string');
      const r = await root();
      const settings = config(r);
      const store = createStore(r);
      const session = sessionFor(r, args.session);
      const caller = plannerId();
      let job = await readJob(store, args.jobId);
      if (LIVE.has(job.status)) {
        if (args.interrupt !== true) {
          throw fail('job-busy', `Job ${job.id} is still ${job.status}: wait for it, or pass interrupt: true to stop this turn and then send`, { status: job.status });
        }
        // Everything that would refuse the send is checked before anything is stopped.
        planSend({ job: { ...job, status: 'completed' }, jobs: [], request: args, role: env.AGENTHUB_RELAY_ROLE, session, caller, config: settings });
        await requestCancel(store, job.id);
        job = await waitForEnd(store, job.id, STOP_WAIT_MS, signal);
        if (!TERMINAL.has(job.status)) {
          throw fail('interrupt-timeout', `Job ${job.id} did not stop within ${STOP_WAIT_MS / 1000} seconds; nothing was sent`);
        }
      }
      if (!job.native?.sessionId) {
        const found = sessionFromLogs(store, job);
        if (found) {
          job = await store.update(job.id, draft => {
            draft.native = { ...(draft.native ?? {}), sessionId: found };
          });
        }
      }
      return store.withDispatchLock(async () => {
        const jobs = await listJobs(store);
        const current = jobs.find(entry => entry.id === job.id) ?? job;
        if (!TERMINAL.has(current.status)) throw fail('job-busy', `Job ${current.id} is ${current.status}: another turn got there first`);
        const plan = planSend({ job: current, jobs, request: args, role: env.AGENTHUB_RELAY_ROLE, session, caller, config: settings });
        const queued = await queueTurn(r, store, current.id, {
          kind: 'send',
          by: 'planner',
          message: plan.message,
          ...(args.interrupt === true ? { interrupted: true } : {}),
        }, { endTakeover: args.force === true });
        const watching = watcher();
        return {
          jobId: current.id,
          turn: queued.turn,
          status: queued.job.status,
          executor: current.executor,
          sessionId: queued.job.native?.sessionId,
          watcher: watching,
          next: nextFor(queued.job, { watcherActive: watching.active }),
        };
      });
    },

    async relay_takeover(args, { signal }) {
      refuseExecutor('take jobs over');
      const r = await root();
      const settings = config(r);
      const store = createStore(r);
      let job = await readJob(store, args.jobId);
      const integration = job.integration ?? 'none';
      if (integration !== 'none') {
        throw fail(RESERVATIONS.has(integration) ? 'job-busy' : 'already-integrated', `Job ${job.id} is ${integration}; there is nothing to take over`);
      }
      const sessionId = job.native?.sessionId ?? sessionFromLogs(store, job);
      if (!sessionId) {
        throw fail('resume-unsupported', `Job ${job.id} has no ${job.executor} session to take over: the executor reported none${LIVE.has(job.status) ? ' yet' : ''}.`, { executor: job.executor });
      }
      if (!SESSION_ID.test(sessionId)) throw fail('invalid-session', `The session id "${sessionId}" of job ${job.id} is not one the relay passes on`);
      let stopped = false;
      if (LIVE.has(job.status)) {
        if (args.stop !== true) {
          throw fail('job-running', `Job ${job.id} is still ${job.status} headless. Pass stop: true to stop this turn first; its session and worktree stay.`, { status: job.status });
        }
        await requestCancel(store, job.id);
        job = await waitForEnd(store, job.id, STOP_WAIT_MS, signal);
        if (!TERMINAL.has(job.status)) throw fail('stop-timeout', `Job ${job.id} did not stop within ${STOP_WAIT_MS / 1000} seconds`);
        stopped = true;
      }
      const command = executorCommand(job.executor, settings, { env, platform });
      const ways = adapterFor(job.executor).takeover({ command, sessionId });
      const cwd = path.join(r, job.worktree);
      const taken = await store.update(job.id, draft => {
        if ((draft.integration ?? 'none') !== 'none') throw fail('already-integrated', `Job ${draft.id} is ${draft.integration}`);
        if (!TERMINAL.has(draft.status)) throw fail('job-busy', `Job ${draft.id} is ${draft.status}`);
        draft.takeover = { at: new Date().toISOString(), sessionId, ...(stopped ? { stopped: true } : {}) };
        draft.native = { ...(draft.native ?? {}), sessionId };
      });
      const describe = way => way && {
        label: way.label,
        ...(way.url ? { url: way.url } : { command: displayCommand(way.argv, platform) }),
        ...(way.verified === false ? { verified: false } : {}),
        ...(way.note ? { note: way.note } : {}),
      };
      let opened;
      if (args.open === true) {
        opened = ways.app
          ? await open(ways.app.url ? { url: ways.app.url } : { argv: ways.app.argv, cwd }, { env, platform })
          : { ok: false, error: `${job.executor} has no desktop app to open; run the terminal command in the worktree.` };
      }
      return {
        jobId: job.id,
        executor: job.executor,
        sessionId,
        cwd,
        stopped,
        ...(ways.app ? { app: describe(ways.app) } : {}),
        terminal: { ...describe(ways.terminal), cwd },
        ...(ways.note ? { note: ways.note } : {}),
        ...(job.write ? {} : { warning: 'This is a read-only review: the session you open is not held to that rule, and any change made there is reported out of scope and cannot be applied.' }),
        ...(opened ? { opened } : {}),
        instruction: 'Close the interactive session before handing the job back with relay_collect. While the job is taken over the relay sends it nothing.',
        next: nextFor(taken),
      };
    },

    async relay_collect(args) {
      refuseExecutor('collect jobs');
      const r = await root();
      const store = createStore(r);
      const job = await readJob(store, args.jobId);
      if (LIVE.has(job.status)) throw fail('job-running', `Job ${job.id} is still ${job.status}`);
      return store.withDispatchLock(async () => {
        const jobs = await listJobs(store);
        const current = jobs.find(entry => entry.id === job.id) ?? job;
        const integration = current.integration ?? 'none';
        if (integration !== 'none') {
          throw fail(RESERVATIONS.has(integration) ? 'job-busy' : 'already-integrated', `Job ${current.id} is ${integration}`);
        }
        if (current.write && !holdsScope(current)) {
          const conflict = scopeConflict(current, jobs);
          if (conflict) {
            throw fail('scope-conflict', `Job ${current.id} gave up its scope when it ended ${current.status}, and "${conflict.left}" now overlaps "${conflict.right}" claimed by job ${conflict.job.id}`, { job: conflict.job.id });
          }
        }
        const queued = await queueTurn(r, store, current.id, { kind: 'collect', by: current.takeover ? 'user' : 'planner' });
        const watching = watcher();
        return {
          jobId: current.id,
          turn: queued.turn,
          status: queued.job.status,
          note: 'The checks run and the changes are collected in the background; wait for the job, then read its result.',
          watcher: watching,
          next: nextFor(queued.job, { watcherActive: watching.active }),
        };
      });
    },

    async relay_status(args) {
      if (args.watch === true) watcherSeenAt = Date.now();
      const r = await root();
      const store = createStore(r);
      if (args.jobId !== undefined) {
        const job = await readJob(store, args.jobId);
        const watching = watcher();
        return { job: summarize(job), watcher: watching, next: nextFor(job, { watcherActive: watching.active }) };
      }
      const jobs = (await listJobs(store)).filter(job => args.all === true || job.integration !== 'discarded');
      const listed = jobs.map(summarize);
      const totals = {};
      for (const job of listed) {
        for (const [key, value] of Object.entries(job.usage ?? {})) totals[key] = (totals[key] ?? 0) + value;
      }
      if (totals.costUsd !== undefined) totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
      return {
        jobs: listed,
        running: jobs.filter(job => !TERMINAL.has(job.status)).length,
        ...(Object.keys(totals).length ? { usage: totals } : {}),
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
      const n = turnNumber(job);
      if (TERMINAL.has(job.status) && !(job.resultFetchedTurn >= n)) {
        job = await store.update(job.id, draft => {
          draft.resultFetchedAt = new Date().toISOString();
          draft.resultFetchedTurn = n;
        });
      }
      const p = store.paths(job.id);
      const turnPaths = p.turn(n);
      const perTurn = fs.existsSync(turnPaths.dir);
      const rel = file => relativePath(r, file);
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
        ...(job.native?.sessionId ? { native: { sessionId: job.native.sessionId } } : {}),
        ...(job.takeover ? { takeover: job.takeover } : {}),
        turns: turnsOf(job).map(turn => ({
          n: turn.n,
          kind: turn.kind,
          by: turn.by,
          status: turn.status,
          ...(turn.verification ? { verification: turn.verification } : {}),
          ...(turn.message ? { message: clipText(turn.message, MAX_LISTED_MESSAGE_CHARS) } : {}),
          ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
          ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
          ...(turn.summary ? { summary: turn.summary } : {}),
          ...(turn.usage ? { usage: turn.usage } : {}),
          ...(turn.error ? { error: turn.error } : {}),
        })),
        logs: {
          executor: rel(perTurn ? turnPaths.executorLog : p.executorLog),
          worker: rel(p.workerLog),
          final: rel(p.final),
          patch: rel(p.patch),
          checks: checkLogs,
          ...(perTurn ? { turn: rel(turnPaths.dir) } : {}),
        },
        next: nextFor(job),
      };
    },

    async relay_apply(args) {
      const r = await root();
      const store = createStore(r);
      const job = await readJob(store, args.jobId);
      // Every check and the reservation are one update under the job's lock;
      // the git work runs outside it, so a slow apply cannot outlive the lock.
      const reserved = await store.update(job.id, draft => {
        if (!TERMINAL.has(draft.status)) throw fail('job-running', `Job ${draft.id} is still ${draft.status}`);
        const integration = draft.integration ?? 'none';
        if (RESERVATIONS.has(integration)) throw fail('job-busy', `Job ${draft.id} is ${integration}`);
        if (integration !== 'none') throw fail('already-integrated', `Job ${draft.id} was already ${integration}`);
        if (!draft.write) throw fail('read-only-job', `Job ${draft.id} is a read-only review; discard it instead`);
        if (draft.takeover) {
          throw fail('taken-over', `Job ${draft.id} is taken over: its patch predates what was done there. Hand it back with relay_collect first.`);
        }
        if (draft.status !== 'completed' && args.force !== true) {
          throw fail('job-not-completed', `Job ${draft.id} ended ${draft.status}; pass force: true to apply it anyway`);
        }
        if ((draft.outOfScope ?? []).length > 0 && args.allowOutOfScope !== true) {
          throw fail('out-of-scope', `Job ${draft.id} changed files outside its scope: ${draft.outOfScope.join(', ')}; pass allowOutOfScope: true to apply them`, {
            outOfScope: draft.outOfScope,
          });
        }
        draft.integration = 'applying';
        draft.integrationPid = process.pid;
        draft.integrationAt = new Date().toISOString();
      });
      try {
        // The main tree changes under the repository's dispatch lock, so no
        // dispatch snapshots a half-applied tree.
        await store.withDispatchLock(() => applyPatch(r, store.paths(job.id).patch));
      } catch (err) {
        await store.update(job.id, draft => {
          draft.integration = 'none';
          delete draft.integrationPid;
          delete draft.integrationAt;
        }).catch(() => {});
        throw err;
      }
      // The patch is in the working tree now: record that before cleanup,
      // so a failed cleanup cannot make the job look unapplied.
      await store.update(job.id, draft => {
        draft.integration = 'applied';
        draft.appliedAt = new Date().toISOString();
        delete draft.integrationPid;
        delete draft.integrationAt;
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
        files: reserved.changedFiles ?? [],
        worktreeRemoved,
        note: 'The changes are in your working tree, unstaged. Review and commit them.',
      };
    },

    async relay_discard(args) {
      const r = await root();
      const store = createStore(r);
      const job = await readJob(store, args.jobId);
      await store.update(job.id, draft => {
        if (!TERMINAL.has(draft.status)) throw fail('job-running', `Job ${draft.id} is still ${draft.status}; cancel it first`);
        const integration = draft.integration ?? 'none';
        if (RESERVATIONS.has(integration)) throw fail('job-busy', `Job ${draft.id} is ${integration}`);
        if (integration !== 'none') throw fail('already-integrated', `Job ${draft.id} was already ${integration}`);
        if (draft.takeover && args.force !== true) {
          throw fail('taken-over', `Job ${draft.id} is taken over and someone may still be working in its worktree; pass force: true to discard it anyway`);
        }
        draft.integration = 'discarding';
        draft.integrationPid = process.pid;
        draft.integrationAt = new Date().toISOString();
      });
      try {
        await removeWorktree(r, job.id);
      } catch (err) {
        await store.update(job.id, draft => {
          draft.integration = 'none';
          delete draft.integrationPid;
          delete draft.integrationAt;
        }).catch(() => {});
        throw err;
      }
      await store.update(job.id, draft => {
        draft.integration = 'discarded';
        draft.discardedAt = new Date().toISOString();
        delete draft.integrationPid;
        delete draft.integrationAt;
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
      const flagged = await requestCancel(store, job.id);
      const pid = flagged.worker?.pid;
      if (pid && isAlive(pid) && platform === 'win32') {
        return { jobId: job.id, cancelling: true, note: 'The worker sees the request within a second, stops the executor and ends the job cancelled.' };
      }
      if (pid && isAlive(pid)) {
        return { jobId: job.id, cancelling: true, note: 'The worker is stopping the executor; the job ends cancelled.' };
      }
      const ended = await readJob(store, job.id);
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
