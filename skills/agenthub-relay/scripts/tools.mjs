// The relay_* tools: the one entrance for every planner, whichever agent it
// is. Each tool takes plain JSON and returns plain JSON; errors carry a code.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  configLayers, configPath, EXECUTOR_IDS, loadConfig, parseRoute, PLANNER_IDS, plannerFromName, RESERVED, TIERS, userConfigPath, writeSettings,
} from './config.mjs';
import { describeExecutors } from './executors.mjs';
import { addWorktree, applyPatch, ensureExcluded, removeWorktree, repoRoot, snapshotBase } from './git.mjs';
import { ACCEPTED, agentDefaults, assertRoute, catalogFor, checkRoute, MODEL_AGENTS } from './models.mjs';
import { workerSpawnOptions } from './platform.mjs';
import { planDispatch } from './policy.mjs';
import { createSessionStore, describeTiers, isSessionId, newSessionId, plainRoute, routeText } from './session.mjs';
import { createStore, isAlive, isJobId, newJobId, TERMINAL } from './store.mjs';

export const VERSION = '0.3.0';
export const MAX_WAIT_SECONDS = 50;
/** A watcher counts as active while it polled this recently. */
export const WATCHER_ACTIVE_MS = 3 * 60_000;

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const POLL_MS = 500;

function fail(code, message, details) {
  return Object.assign(new Error(message), { code }, details === undefined ? {} : { details });
}

const jobIdSchema = { type: 'string', description: 'A job id returned by relay_dispatch, such as j20261029-061530-a1b2c3.' };

const routeSchema = { type: 'string', description: 'executor[:model][@effort], for example claude:opus@high, codex:gpt-5.1-codex@medium or dsh.' };

export const TOOLS = Object.freeze([
  {
    name: 'relay_agents',
    description:
      'List the executors (codex, claude, dsh; agy and acp are reserved), whether each is installed, which planner you are taken to be, the active profile and why, the executor, model and effort each tier goes to, each agent\'s own default model, and the current planner session.',
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
      'If the result says watcher.active, end your turn: you will be woken when the job ends. Otherwise poll with relay_wait.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the executor should do, self-contained.' },
        tier: { type: 'string', enum: [...TIERS] },
        session: { type: 'string', description: "The confirmed session id; defaults to this connection's session." },
        executor: { type: 'string', description: 'Override the session\'s route: codex, claude or dsh.' },
        model: { type: 'string', description: "Model for this job, checked and passed through the executor's own flag (codex -m, claude --model); dsh uses its own settings and refuses one." },
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
    ...(job.session ? { session: job.session } : {}),
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

  async function readJob(store, jobId) {
    if (!isJobId(jobId)) throw fail('unknown-job', `"${jobId}" is not a job id`);
    return store.reconcile(store.read(jobId));
  }

  async function listJobs(store) {
    return Promise.all(store.list().map(job => store.reconcile(job)));
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
        executors: describeExecutors(settings, env, defaults),
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
      if (env.AGENTHUB_RELAY_ROLE === 'executor') {
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
      if (args.session !== undefined && !isSessionId(args.session)) throw fail('unknown-session', `"${args.session}" is not a session id`);
      const sessionId = args.session ?? currentSessionId;
      const session = sessionId ? createSessionStore(r).read(sessionId) : null;
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
          planner: caller === 'unknown' && session ? session.planner : caller,
          profile: session?.profile ?? settings.profile,
          session: session?.id ?? null,
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
