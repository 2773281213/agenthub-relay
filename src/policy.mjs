// Dispatch policy and guards: the planner session, tier mapping, scope rules,
// conflicts between concurrent write jobs, reserved executors and the
// executor role. Every decision here is a pure function of its inputs.

import { MODEL_NAME, MODEL_NAME_RULE, RESERVED, TIERS, WRITE_TIERS } from './config.mjs';

export const MAX_TASK_CHARS = 100_000;
export const MAX_CHECKS = 20;
export const MAX_CHECK_CHARS = 2_000;
export const MAX_TITLE_CHARS = 120;
export const MAX_ACCEPTANCE_CHARS = 4_000;

/** Status values of a job whose worker is still running. */
const LIVE = new Set(['queued', 'running', 'verifying']);

export class PolicyError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// The same path rule Birdview uses for project-relative paths: no leading
// slash, no `.`/`..`/`.git` segment, no empty segment, no backslash, colon or
// control character. `.` on its own means the whole repository.
const PATH_RULE =
  /^(?!\/)(?!.*(?:^|\/)(?:\.\.?|\.git)(?:\/|$))(?!.*\/\/)(?!.*[\\:\u0000-\u001f\u007f])[^/].*[^/]$|^[^./\\:\u0000-\u001f\u007f]$/;

/** Validates and normalizes one scope entry (a file or directory path). */
export function normalizeScopePath(entry) {
  if (typeof entry !== 'string') throw new PolicyError('invalid-scope', 'Scope entries must be strings');
  let value = entry.trim();
  if (value === '.' || value === './') return '.';
  if (value.startsWith('./')) value = value.slice(2);
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  if (!PATH_RULE.test(value)) {
    throw new PolicyError(
      'invalid-scope',
      `Scope entry "${entry}" must be a project-relative path without "..", ".git", backslashes or a leading slash`,
    );
  }
  return value;
}

/** Whether a scope entry covers a file path (directory-prefix semantics). */
export function covers(entry, file) {
  return entry === '.' || file === entry || file.startsWith(`${entry}/`);
}

/** The first pair of entries that overlap between two scopes, or null. */
export function scopesOverlap(a, b) {
  for (const left of a) {
    for (const right of b) {
      if (covers(left, right) || covers(right, left)) return { left, right };
    }
  }
  return null;
}

/** Files that no entry of the scope covers. */
export function outOfScope(files, scope) {
  return files.filter(file => !scope.some(entry => covers(entry, file)));
}

/**
 * Whether a job still claims its scope: its worker is live, or it completed
 * and its patch has been neither applied nor discarded.
 */
export function holdsScope(job) {
  if (!job.write) return false;
  if (LIVE.has(job.status)) return true;
  return job.status === 'completed' && (job.integration ?? 'none') === 'none';
}

function cleanText(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new PolicyError('invalid-request', `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new PolicyError('invalid-request', `${field} must be a string`);
  const text = value.trim();
  if (required && text === '') throw new PolicyError('invalid-request', `${field} must not be empty`);
  if (text.length > max) throw new PolicyError('invalid-request', `${field} is longer than ${max} characters`);
  return text === '' ? undefined : text;
}

function cleanList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PolicyError('invalid-request', `${field} must be a list`);
  return value;
}

function cleanName(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !MODEL_NAME.test(value)) {
    throw new PolicyError('invalid-request', `${field} must be ${MODEL_NAME_RULE}`);
  }
  return value;
}

/**
 * The model and effort a job runs with: the request's, else the tier route's
 * (only when the route's executor is the one running), else the executor's
 * default. An executor without a flag for one of them refuses it, naming the
 * model its own settings choose when that is known (`agentDefault`).
 */
function selectModel({ request, route, executor, executorConfig, agentDefault }) {
  const fromRoute = route?.executor === executor ? route : {};
  const model = cleanName(request.model, 'model') ?? fromRoute.model ?? executorConfig.model;
  const effort = cleanName(request.effort, 'effort') ?? fromRoute.effort ?? executorConfig.effort;
  if (model !== undefined && !executorConfig.modelArgs?.length) {
    const own = agentDefault?.model
      ? ` Its own settings choose ${agentDefault.model}${agentDefault.modelFrom ? ` (${agentDefault.modelFrom})` : ''}.`
      : '';
    throw new PolicyError(
      'model-unsupported',
      `The ${executor} executor takes no model from the relay: it uses its own settings.${own} Leave the model out, or configure executors.${executor}.modelArgs if your ${executor} has such a flag.`,
      { executor, model, ...(agentDefault?.model ? { agentDefault: agentDefault.model } : {}) },
    );
  }
  if (effort !== undefined && !executorConfig.effortArgs?.length) {
    throw new PolicyError(
      'effort-unsupported',
      `The ${executor} executor has no flag for reasoning effort; configure executors.${executor}.effortArgs to use one`,
      { executor, effort },
    );
  }
  return { model, effort };
}

function defaultTitle(task) {
  const line = task.split('\n').find(text => text.trim() !== '') ?? task;
  const title = line.trim();
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

/**
 * The planner-session guard: a dispatch needs a session the user confirmed
 * (unless sessions.required is off), and a caller identified as another agent
 * than the session's planner is refused. An unidentified caller holding the
 * session is taken to be its planner.
 *
 * @param {object} input
 * @param {object|null} input.session the session record, or null for none
 * @param {string} [input.caller] the identified planner id, or 'unknown'
 * @param {boolean} input.required config.sessions.required
 */
export function checkSession({ session, caller, required }) {
  if (session === null || session === undefined) {
    if (required) {
      throw new PolicyError(
        'session-required',
        'Dispatch needs a planner session the user confirmed: run "session start --planner <you>" (or relay_session with action "start"), show the user the saved executors and models, and confirm with their answer.',
      );
    }
    return;
  }
  if (session.status !== 'confirmed') {
    throw new PolicyError(
      'session-required',
      `Session ${session.id} is waiting for the user's confirmation: show the user what "session start" listed, then confirm it with their answer.`,
      { session: session.id },
    );
  }
  if (caller && caller !== 'unknown' && caller !== session.planner) {
    throw new PolicyError(
      'planner-mismatch',
      `Session ${session.id} was confirmed for the ${session.planner} planner, but this call comes from ${caller}. Start and confirm your own session to plan as ${caller}.`,
      { session: session.id, planner: session.planner, caller },
    );
  }
}

/**
 * Decides whether a dispatch may go ahead and what it becomes.
 *
 * @param {object} input
 * @param {object} input.request what the planner asked for
 * @param {object} input.config the loaded configuration (config.mjs)
 * @param {object[]} input.jobs every recorded job, for scope conflicts
 * @param {string|undefined} input.role AGENTHUB_RELAY_ROLE of the caller
 * @param {object|null} [input.session] the planner session (see checkSession);
 *   when given its confirmed routes are used. Leave it out to skip the guard.
 * @param {string} [input.caller] the identified planner id
 * @param {object} [input.agentDefaults] each agent's own default model, for messages
 * @returns {object} the normalized job plan
 */
export function planDispatch({ request, config, jobs = [], role, session, caller, agentDefaults = {} }) {
  if (role === 'executor') {
    throw new PolicyError(
      'executor-role',
      'This process runs as an agenthub-relay executor (AGENTHUB_RELAY_ROLE=executor); executors may not dispatch further jobs.',
    );
  }
  if (session !== undefined) checkSession({ session, caller, required: config.sessions?.required ?? true });
  if (request === null || typeof request !== 'object') {
    throw new PolicyError('invalid-request', 'The dispatch request must be an object');
  }

  const task = cleanText(request.task, 'task', MAX_TASK_CHARS, { required: true });
  const tier = request.tier;
  if (!TIERS.includes(tier)) {
    throw new PolicyError('invalid-tier', `tier must be one of ${TIERS.join(', ')}`);
  }
  const write = WRITE_TIERS.has(tier);

  const route = (session?.routes ?? config.routes)?.[tier];
  const executor = request.executor ?? route?.executor ?? config.mapping[tier];
  if (RESERVED[executor]) {
    throw new PolicyError('reserved-executor', RESERVED[executor], { executor });
  }
  if (!config.executors[executor]) {
    throw new PolicyError('unknown-executor', `Unknown executor "${executor}" (known: ${Object.keys(config.executors).join(', ')})`);
  }

  const rawScope = cleanList(request.scope, 'scope');
  const scope = [...new Set(rawScope.map(normalizeScopePath))];
  const checks = cleanList(request.checks, 'checks').map((command, index) =>
    cleanText(command, `checks[${index}]`, MAX_CHECK_CHARS, { required: true }),
  );
  if (checks.length > MAX_CHECKS) {
    throw new PolicyError('invalid-request', `At most ${MAX_CHECKS} checks may be declared`);
  }

  if (tier === 'light') {
    if (scope.length === 0) {
      throw new PolicyError('light-needs-scope', 'A light job must declare the files it may change (scope)');
    }
    if (scope.length > config.light.maxScopeEntries) {
      throw new PolicyError(
        'light-scope-too-wide',
        `A light job may declare at most ${config.light.maxScopeEntries} scope entries; use the deep tier for wider work`,
      );
    }
    if (scope.includes('.')) {
      throw new PolicyError('light-scope-too-wide', 'A light job may not claim the whole repository; use the deep tier');
    }
    if (checks.length === 0) {
      throw new PolicyError('light-needs-checks', 'A light job must declare at least one check command');
    }
  }
  if (tier === 'deep' && scope.length === 0) {
    throw new PolicyError('deep-needs-scope', 'A deep job must declare its scope (use "." for the whole repository)');
  }
  const effectiveScope = scope.length ? scope : ['.'];

  if (write) {
    for (const job of jobs) {
      if (!holdsScope(job)) continue;
      const overlap = scopesOverlap(effectiveScope, job.scope ?? ['.']);
      if (overlap) {
        throw new PolicyError(
          'scope-conflict',
          `Scope "${overlap.left}" overlaps "${overlap.right}" claimed by job ${job.id} (${job.status}${
            job.status === 'completed' ? ', not yet applied or discarded' : ''
          })`,
          { job: job.id },
        );
      }
    }
  }

  const { model, effort } = selectModel({
    request,
    route,
    executor,
    executorConfig: config.executors[executor],
    agentDefault: agentDefaults[executor],
  });

  let timeoutMinutes = config.executors[executor].timeoutMinutes;
  if (request.timeoutMinutes !== undefined) {
    const value = request.timeoutMinutes;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 24 * 60) {
      throw new PolicyError('invalid-request', 'timeoutMinutes must be a number between 0 and 1440');
    }
    timeoutMinutes = value;
  }

  return {
    task,
    tier,
    write,
    executor,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    scope: effectiveScope,
    checks,
    title: cleanText(request.title, 'title', MAX_TITLE_CHARS) ?? defaultTitle(task),
    acceptance: cleanText(request.acceptance, 'acceptance', MAX_ACCEPTANCE_CHARS),
    timeoutMinutes,
  };
}
