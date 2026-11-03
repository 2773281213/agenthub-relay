// The model catalog: which models each agent offers, which model and effort it
// uses by default, and whether a route's model and effort check out. It reads
// the agents' own settings files and never writes them. Keyed by agent id, it
// serves a planner and an executor alike.
//
//   codex  - `codex app-server` over stdio (initialize, initialized, model/list);
//            defaults from config.toml (project .codex/ first, then CODEX_HOME)
//   claude - the documented model aliases, plus GET /v1/models when an API key
//            is in the environment; defaults from ANTHROPIC_MODEL and settings.json
//   dsh    - no model is chosen by the relay; its default and the models of its
//            configured providers come from $DSH_HOME/settings.yaml

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { MODEL_NAME, RESERVED, userConfigPath } from './config.mjs';
import { childSpawnOptions, envValue, killTree, resolveCommand } from './platform.mjs';
import { writeJsonAtomic } from './store.mjs';
import { parseYaml } from './yaml-lite.mjs';

export const MODEL_AGENTS = Object.freeze(['codex', 'claude', 'dsh']);

/** Claude Code's documented model aliases (code.claude.com/docs/en/model-config). */
export const CLAUDE_ALIASES = Object.freeze(['default', 'best', 'fable', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]', 'opusplan']);
/** Claude Code's documented effort levels. */
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** How long a fetched model list is reused. */
export const CATALOG_TTL_MS = 24 * 60 * 60_000;
export const CODEX_LIST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

/** Check outcomes that let a route through. */
export const ACCEPTED = Object.freeze(new Set(['verified', 'format-only', 'agent-default']));

function fail(code, message, details) {
  return Object.assign(new Error(message), { code }, details === undefined ? {} : { details });
}

function homeOf(env) {
  return envValue(env, 'HOME') || envValue(env, 'USERPROFILE') || null;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Each agent's own default model, read from its settings files.

/** Top-level `key = value` pairs of a TOML file (everything before the first table). */
export function tomlTopLevel(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value;
    const basic = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    const literal = /^'([^']*)'/.exec(rest);
    if (basic) value = basic[1].replace(/\\(["\\])/g, '$1');
    else if (literal) value = literal[1];
    else value = rest.replace(/\s+#.*$/, '').trim();
    values[key] = value;
  }
  return values;
}

function codexDefault({ env, root }) {
  const codexHome = envValue(env, 'CODEX_HOME') || (homeOf(env) ? path.join(homeOf(env), '.codex') : null);
  const files = [root ? path.join(root, '.codex', 'config.toml') : null, codexHome ? path.join(codexHome, 'config.toml') : null].filter(Boolean);
  const result = { model: null, effort: null, modelFrom: null, effortFrom: null };
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    const values = tomlTopLevel(text);
    if (result.model === null && values.model) Object.assign(result, { model: values.model, modelFrom: file });
    if (result.effort === null && values.model_reasoning_effort) {
      Object.assign(result, { effort: values.model_reasoning_effort, effortFrom: file });
    }
  }
  return result;
}

function claudeDefault({ env, root }) {
  const configDir = envValue(env, 'CLAUDE_CONFIG_DIR') || (homeOf(env) ? path.join(homeOf(env), '.claude') : null);
  const result = { model: null, effort: null, modelFrom: null, effortFrom: null, problems: [] };
  if (envValue(env, 'ANTHROPIC_MODEL')) Object.assign(result, { model: envValue(env, 'ANTHROPIC_MODEL'), modelFrom: 'ANTHROPIC_MODEL' });
  if (envValue(env, 'CLAUDE_CODE_EFFORT_LEVEL')) {
    Object.assign(result, { effort: envValue(env, 'CLAUDE_CODE_EFFORT_LEVEL'), effortFrom: 'CLAUDE_CODE_EFFORT_LEVEL' });
  }
  const files = [
    root ? path.join(root, '.claude', 'settings.local.json') : null,
    root ? path.join(root, '.claude', 'settings.json') : null,
    configDir ? path.join(configDir, 'settings.json') : null,
  ].filter(Boolean);
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      result.problems.push(`${file} is not valid JSON: ${err.message}`);
      continue;
    }
    if (result.model === null && typeof data?.model === 'string') Object.assign(result, { model: data.model, modelFrom: file });
    if (result.effort === null && typeof data?.effortLevel === 'string') {
      Object.assign(result, { effort: data.effortLevel, effortFrom: file });
    }
  }
  if (result.problems.length === 0) delete result.problems;
  return result;
}

/** DeepSeek Harness's settings file, parsed, or a problem describing why it could not be read. */
function dshSettings({ env }) {
  const dshHome = envValue(env, 'DSH_HOME') || (homeOf(env) ? path.join(homeOf(env), '.dsh') : null);
  if (!dshHome) return { file: null, data: null };
  for (const name of ['settings.yaml', 'settings.yml', 'settings.json']) {
    const file = path.join(dshHome, name);
    const text = readText(file);
    if (text === null) continue;
    try {
      return { file, data: name.endsWith('.json') ? JSON.parse(text) : parseYaml(text) };
    } catch (err) {
      return { file, data: null, problem: `${file} could not be read: ${err.message}` };
    }
  }
  return { file: null, data: null };
}

function dshDefault({ env }) {
  const { file, data, problem } = dshSettings({ env });
  const result = { model: null, effort: null, provider: null, modelFrom: null, effortFrom: null };
  if (problem) result.problems = [problem];
  const selection = data?.['agent-default-model'];
  if (selection && typeof selection === 'object') {
    if (typeof selection.model === 'string') Object.assign(result, { model: selection.model, modelFrom: file });
    if (typeof selection.provider === 'string') result.provider = selection.provider;
    if (typeof selection.reasoningEffort === 'string') Object.assign(result, { effort: selection.reasoningEffort, effortFrom: file });
  }
  return result;
}

/**
 * The model and effort an agent uses when the relay passes none, and the file
 * each comes from. `model: null` means the agent picks its own built-in default.
 */
export function agentDefault(agent, { env = process.env, root } = {}) {
  if (agent === 'codex') return codexDefault({ env, root });
  if (agent === 'claude') return claudeDefault({ env, root });
  if (agent === 'dsh') return dshDefault({ env });
  return { model: null, effort: null, modelFrom: null, effortFrom: null };
}

/** agentDefault for every agent with a catalog. */
export function agentDefaults({ env = process.env, root } = {}) {
  return Object.fromEntries(MODEL_AGENTS.map(agent => [agent, agentDefault(agent, { env, root })]));
}

// ---------------------------------------------------------------------------
// Listing models.

function readCodexModel(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null;
  if (!id) return null;
  const model = typeof value.model === 'string' && value.model.trim() ? value.model.trim() : id;
  const efforts = Array.isArray(value.supportedReasoningEfforts)
    ? [...new Set(value.supportedReasoningEfforts.map(entry => (typeof entry === 'string' ? entry : entry?.reasoningEffort)).filter(e => typeof e === 'string' && e))]
    : [];
  return {
    id,
    model,
    ...(typeof value.displayName === 'string' && value.displayName.trim() ? { displayName: value.displayName.trim() } : {}),
    ...(typeof value.isDefault === 'boolean' ? { isDefault: value.isDefault } : {}),
    ...(typeof value.hidden === 'boolean' ? { hidden: value.hidden } : {}),
    efforts,
    ...(typeof value.defaultReasoningEffort === 'string' ? { defaultEffort: value.defaultReasoningEffort } : {}),
  };
}

/**
 * Asks `codex app-server` for the models the signed-in account can use.
 * The process is ended (with its tree) however the call ends.
 */
export function listCodexModels({ command = 'codex', env = process.env, platform = process.platform, timeoutMs = CODEX_LIST_TIMEOUT_MS, clientVersion = '0' } = {}) {
  let resolved;
  try {
    resolved = resolveCommand(command, { env, platform });
  } catch (err) {
    return Promise.reject(fail(err.code ?? 'agent-unusable', err.message));
  }
  if (!resolved) return Promise.reject(fail('agent-missing', `"${command}" is not on PATH; codex cannot be asked for its models`));

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.file, [...resolved.prefixArgs, 'app-server'], {
      env: { ...env, ...(resolved.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...childSpawnOptions(platform),
    });
    const pending = new Map();
    let nextId = 1;
    let buffer = '';
    let stderr = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const { reject: rejectOne } of pending.values()) rejectOne(fail('model-list-failed', 'codex app-server stopped'));
      pending.clear();
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      if (child.exitCode === null && child.signalCode === null) {
        if (!killTree(child.pid, { platform })) {
          try {
            child.kill('SIGKILL');
          } catch {
            // gone
          }
        }
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(fail('model-list-timeout', `codex app-server did not list its models within ${Math.round(timeoutMs / 1000)} seconds`)),
      timeoutMs,
    );

    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method, params) =>
      new Promise((resolveOne, rejectOne) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveOne, reject: rejectOne });
        send({ id, method, params });
      });

    child.on('error', err => finish(fail('agent-unusable', `codex app-server could not start: ${err.message}`)));
    child.on('exit', code => {
      const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      finish(fail('model-list-failed', `codex app-server exited (${code ?? 'signal'}) before listing its models${detail ? `: ${detail}` : ''}`));
    });
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.stdin.on('error', () => {
      // reported by the exit handler
    });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined || !pending.has(message.id) || message.method !== undefined) continue;
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(fail('model-list-failed', `codex app-server: ${message.error.message ?? JSON.stringify(message.error)}`));
        else waiter.resolve(message.result);
      }
    });

    (async () => {
      await request('initialize', { clientInfo: { name: 'agenthub-relay', title: 'agenthub-relay', version: clientVersion } });
      send({ method: 'initialized' });
      const models = [];
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await request('model/list', { limit: 100, cursor, includeHidden: false });
        if (!result || !Array.isArray(result.data)) throw fail('model-list-failed', 'codex app-server answered model/list without a data list');
        for (const entry of result.data) {
          const model = readCodexModel(entry);
          if (model) models.push(model);
        }
        cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
        if (!cursor) break;
      }
      return models;
    })().then(models => finish(null, models), err => finish(err.code ? err : fail('model-list-failed', err.message)));
  });
}

/** Claude Code's aliases, plus the API's model list when ANTHROPIC_API_KEY is set. */
export async function listClaudeModels({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const models = CLAUDE_ALIASES.map(id => ({ id, kind: 'alias' }));
  const key = envValue(env, 'ANTHROPIC_API_KEY');
  if (!key || typeof fetchImpl !== 'function') return { models, source: 'aliases' };
  const base = (envValue(env, 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
  try {
    let after = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${base}/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
      const response = await fetchImpl(url, {
        headers: { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      for (const entry of Array.isArray(body?.data) ? body.data : []) {
        if (typeof entry?.id === 'string') {
          models.push({ id: entry.id, kind: 'api', ...(typeof entry.display_name === 'string' ? { displayName: entry.display_name } : {}) });
        }
      }
      if (!body?.has_more || typeof body.last_id !== 'string') break;
      after = body.last_id;
    }
    return { models, source: 'aliases+api' };
  } catch (err) {
    return { models, source: 'aliases', apiError: `The model list API could not be read: ${err.message}` };
  }
}

function dshModels({ env }) {
  const { data } = dshSettings({ env });
  const providers = data?.['llm-pi-ai']?.providers;
  const models = [];
  if (providers && typeof providers === 'object') {
    for (const [provider, entry] of Object.entries(providers)) {
      for (const model of Array.isArray(entry?.models) ? entry.models : []) {
        const id = typeof model === 'string' ? model : model?.id;
        if (typeof id === 'string' && id) models.push({ id, provider });
      }
    }
  }
  return models;
}

// ---------------------------------------------------------------------------
// The cache of fetched lists.

/** Where fetched model lists are cached: next to the user configuration file. */
export function modelsCachePath(env = process.env) {
  const user = userConfigPath(env);
  return user ? path.join(path.dirname(user), 'models-cache.json') : null;
}

function readCache(file) {
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeCache(file, key, entry) {
  if (!file) return;
  try {
    const data = readCache(file);
    data[key] = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, data);
  } catch {
    // a cache that cannot be written only costs a refetch
  }
}

function cacheKey(agent, config, env) {
  if (agent === 'codex') return `codex:${config?.executors?.codex?.command ?? 'codex'}`;
  if (agent === 'claude') return `claude:${envValue(env, 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com'}`;
  return agent;
}

/**
 * The catalog entry for one agent: its models (`source` says where they came
 * from), its own default, and `error` when the list could not be read. With
 * `fetch: false` only a cached list is used, so nothing is started.
 */
export async function catalogFor(agent, {
  env = process.env,
  root,
  config,
  refresh = false,
  fetch = true,
  now = Date.now(),
  cacheFile = modelsCachePath(env),
  platform = process.platform,
  clientVersion,
  fetchImpl,
} = {}) {
  if (RESERVED[agent]) return { agent, reserved: true, reason: RESERVED[agent] };
  if (!MODEL_AGENTS.includes(agent)) throw fail('unknown-agent', `Unknown agent "${agent}" (known: ${MODEL_AGENTS.join(', ')})`);
  const base = { agent, default: agentDefault(agent, { env, root }) };
  if (agent === 'dsh') {
    return { ...base, source: 'dsh settings', models: dshModels({ env }), choosesModel: false, note: 'dsh uses its own settings; the relay does not choose its model' };
  }
  const key = cacheKey(agent, config, env);
  const cached = readCache(cacheFile)[key];
  const fresh = cached && typeof cached.fetchedAt === 'string' && now - Date.parse(cached.fetchedAt) < CATALOG_TTL_MS;
  if (fresh && !refresh) return { ...base, source: cached.source, models: cached.models, fetchedAt: cached.fetchedAt, cached: true };

  if (agent === 'claude') {
    if (!fetch) return { ...base, source: 'aliases', models: CLAUDE_ALIASES.map(id => ({ id, kind: 'alias' })) };
    const listed = await listClaudeModels({ env, fetchImpl });
    const entry = { source: listed.source, models: listed.models, fetchedAt: new Date(now).toISOString() };
    if (listed.source !== 'aliases') writeCache(cacheFile, key, entry);
    return { ...base, ...entry, ...(listed.apiError ? { apiError: listed.apiError } : {}) };
  }

  if (!fetch) {
    return { ...base, source: null, models: [], error: { code: 'not-fetched', message: 'The codex model list has not been fetched yet; run "models codex".' } };
  }
  try {
    const models = await listCodexModels({ command: config?.executors?.codex?.command ?? 'codex', env, platform, clientVersion });
    const entry = { source: 'codex app-server', models, fetchedAt: new Date(now).toISOString() };
    writeCache(cacheFile, key, entry);
    return { ...base, ...entry };
  } catch (err) {
    return { ...base, source: null, models: [], error: { code: err.code ?? 'model-list-failed', message: err.message } };
  }
}

// ---------------------------------------------------------------------------
// Checking a route.

function suggestions(models, wanted) {
  const lower = wanted.toLowerCase();
  const names = models.flatMap(m => [m.id, m.model]).filter((name, i, all) => name && all.indexOf(name) === i);
  const close = names.filter(name => name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()));
  return (close.length ? close : names).slice(0, 8);
}

function sourceOf(def) {
  return def?.modelFrom ? ` (from ${def.modelFrom})` : '';
}

/**
 * Checks one route `{ executor, model?, effort? }` against an agent catalog.
 * Returns `{ status, code?, reason, suggestions? }`; status is one of
 * verified, format-only, agent-default, not-in-list, unknown or unsupported.
 * Only verified, format-only and agent-default let the route through.
 */
export function checkRoute(route, catalog) {
  const { executor, model, effort } = route;
  if (RESERVED[executor]) return { status: 'unsupported', code: 'reserved-executor', reason: RESERVED[executor] };
  for (const [field, value] of [['model', model], ['effort', effort]]) {
    if (value !== undefined && (typeof value !== 'string' || !MODEL_NAME.test(value))) {
      return { status: 'unsupported', code: 'invalid-value', reason: `${field} "${value}" is not a valid name` };
    }
  }
  if (executor === 'dsh') {
    if (model === undefined && effort === undefined) {
      const def = catalog?.default;
      return { status: 'agent-default', reason: def?.model ? `dsh uses its own default, ${def.model}${sourceOf(def)}` : 'dsh uses its own settings' };
    }
    const def = catalog?.default;
    return {
      status: 'unsupported',
      code: 'model-unsupported',
      reason: `dsh takes no model or effort from the relay; it uses its own settings${def?.model ? `, where its default model is ${def.model}${sourceOf(def)}` : ''}. Leave the model out for dsh, or change it in DeepSeek Harness.`,
    };
  }
  if (executor === 'claude') {
    if (effort !== undefined && !CLAUDE_EFFORTS.includes(effort)) {
      return { status: 'not-in-list', code: 'effort-unsupported', reason: `Claude Code's effort levels are ${CLAUDE_EFFORTS.join(', ')}`, suggestions: [...CLAUDE_EFFORTS] };
    }
    if (model === undefined) {
      const def = catalog?.default;
      return { status: 'agent-default', reason: def?.model ? `claude uses its own default, ${def.model}${sourceOf(def)}` : 'claude uses its own default model' };
    }
    if (CLAUDE_ALIASES.includes(model)) return { status: 'verified', reason: `${model} is a documented Claude Code alias` };
    return { status: 'format-only', reason: `${model} has a valid form; Claude Code checks the name when the job runs` };
  }
  if (executor === 'codex') {
    if (model === undefined && effort === undefined) {
      const def = catalog?.default;
      return { status: 'agent-default', reason: def?.model ? `codex uses its own default, ${def.model}${sourceOf(def)}` : 'codex uses its own default model' };
    }
    if (!catalog || catalog.error || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      const why = catalog?.error?.message ?? 'codex returned no models';
      return { status: 'unknown', code: 'model-unverified', reason: `The codex model list is not available, so this cannot be checked: ${why}. Leave the model out to use codex's own default.` };
    }
    const models = catalog.models;
    let target;
    if (model !== undefined) {
      target = models.find(m => m.id === model || m.model === model);
      if (!target) {
        return { status: 'not-in-list', code: 'model-unknown', reason: `codex has no model "${model}" for this account`, suggestions: suggestions(models, model) };
      }
    } else {
      const def = catalog.default?.model;
      target = (def && models.find(m => m.id === def || m.model === def)) || models.find(m => m.isDefault);
    }
    if (effort !== undefined && target && target.efforts.length > 0 && !target.efforts.includes(effort)) {
      return {
        status: 'not-in-list',
        code: 'effort-unsupported',
        reason: `${target.model} supports the reasoning efforts ${target.efforts.join(', ')}`,
        suggestions: [...target.efforts],
      };
    }
    if (model === undefined) {
      return target
        ? { status: 'verified', reason: `effort ${effort} is supported by codex's default model ${target.model}` }
        : { status: 'format-only', reason: `codex's default model is unknown, so effort ${effort} is checked by form only` };
    }
    return { status: 'verified', reason: `${model} is in codex's model list${effort ? ` and supports effort ${effort}` : ''}` };
  }
  return { status: 'unsupported', code: 'unknown-executor', reason: `Unknown executor "${executor}"` };
}

/** Throws the check's error when a route does not check out. */
export function assertRoute(route, catalog, where = 'route') {
  const check = checkRoute(route, catalog);
  if (!ACCEPTED.has(check.status)) {
    throw fail(check.code ?? 'model-unknown', `${where}: ${check.reason}`, { ...route, status: check.status, ...(check.suggestions ? { suggestions: check.suggestions } : {}) });
  }
  return check;
}
