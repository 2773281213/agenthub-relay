// Configuration of the hub: which executor (and model) each tier goes to, how
// each executor is run, and which profile a planner gets. Built-in defaults
// are layered under an optional user file and an optional project file.
// Planner-neutral: the planner's identity only selects a profile.

import fs from 'node:fs';
import path from 'node:path';

import { renameWithRetry } from './platform.mjs';

export const TIERS = Object.freeze(['deep', 'light', 'review']);

/** Tiers whose executors may write (inside their own worktree). */
export const WRITE_TIERS = Object.freeze(new Set(['deep', 'light']));

/** Executors with an adapter and the reserved ones that fail closed. */
export const EXECUTOR_IDS = Object.freeze(['codex', 'claude', 'dsh', 'agy', 'acp']);

/** Agents that can plan. `unknown` is recorded when none is recognized. */
export const PLANNER_IDS = Object.freeze(['claude', 'codex', 'dsh', 'agy']);

/**
 * Reserved executors cannot be enabled by configuration: dispatching to them
 * fails closed with this reason.
 */
export const RESERVED = Object.freeze({
  agy: 'Antigravity (agy) is reserved in agenthub-relay; its headless adapter is not implemented yet.',
  acp: 'The generic ACP executor is reserved in agenthub-relay; it is not implemented yet.',
});

/** Model and effort names: no spaces or shell syntax, at most 100 characters. */
export const MODEL_NAME = /^[A-Za-z0-9._:/@+-]{1,100}$/;

export const DEFAULT_CONFIG = Object.freeze({
  profile: 'thread16',
  profiles: {
    // The split proposed in linux.do topic 3028918: complex work to Codex,
    // simple and clear work to DeepSeek (V4 Flash, through DeepSeek Harness),
    // read-only review to Claude Code.
    thread16: { deep: 'codex', light: 'dsh', review: 'claude' },
    // For a Codex planner: Claude Code takes deep work, Codex reviews.
    'codex-planner': { deep: 'claude', light: 'dsh', review: 'codex' },
  },
  // Used only when no configuration file names a profile.
  plannerProfiles: { claude: 'thread16', codex: 'codex-planner' },
  executors: {
    codex: {
      command: 'codex', passEnv: [], timeoutMinutes: 60, extraArgs: [],
      modelArgs: ['-m', '{model}'], effortArgs: ['-c', 'model_reasoning_effort={effort}'],
    },
    claude: {
      command: 'claude', passEnv: [], timeoutMinutes: 45, extraArgs: [], bare: false,
      modelArgs: ['--model', '{model}'], effortArgs: ['--effort', '{effort}'],
    },
    // dsh documents no per-run model flag: its model is set in its own settings.
    dsh: { command: 'dsh', passEnv: [], timeoutMinutes: 30, extraArgs: [], modelArgs: [], effortArgs: [] },
  },
  checks: { timeoutMinutes: 10 },
  light: { maxScopeEntries: 10, maxChangedFiles: 10 },
});

const TOP_KEYS = ['profile', 'profiles', 'plannerProfiles', 'executors', 'checks', 'light'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MINUTES = 24 * 60;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Where the optional project config file lives for a project root. */
export function configPath(root, env = process.env) {
  const named = env.AGENTHUB_RELAY_CONFIG;
  if (named) return path.resolve(root, named);
  return path.join(root, '.agenthub', 'config.json');
}

/** Where the optional user config file lives, or null without a home directory. */
export function userConfigPath(env = process.env) {
  if (env.AGENTHUB_RELAY_USER_CONFIG) return path.resolve(env.AGENTHUB_RELAY_USER_CONFIG);
  const home = env.HOME || env.USERPROFILE;
  const base = env.XDG_CONFIG_HOME || (home ? path.join(home, '.config') : null);
  return base ? path.join(base, 'agenthub-relay', 'config.json') : null;
}

/** The planner id for a name: a planner id itself, or an MCP client name such as "codex-mcp-client". */
export function plannerFromName(name) {
  if (typeof name !== 'string' || name.trim() === '') return 'unknown';
  const text = name.trim().toLowerCase();
  if (PLANNER_IDS.includes(text)) return text;
  if (text.includes('claude')) return 'claude';
  if (text.includes('codex')) return 'codex';
  if (text.includes('antigravity') || text.includes('gemini') || text === 'agy') return 'agy';
  if (text.includes('deepseek') || text.includes('dsh')) return 'dsh';
  return 'unknown';
}

function readFileConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw fail('config-unreadable', `Cannot read ${file}: ${err.message}`);
  }
  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) throw new Error('the top level must be an object');
    return parsed;
  } catch (err) {
    throw fail('config-invalid', `${file} is not valid configuration: ${err.message}`);
  }
}

function checkMinutes(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_MINUTES) {
    throw fail('config-invalid', `${where} must be a number of minutes between 0 and ${MAX_MINUTES}`);
  }
}

function checkName(value, where) {
  if (typeof value !== 'string' || !MODEL_NAME.test(value)) {
    throw fail('config-invalid', `${where} must be a name of letters, digits and . _ : / @ + - (at most 100 characters)`);
  }
}

function checkTemplate(value, placeholder, where) {
  if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string')) {
    throw fail('config-invalid', `${where} must be a list of strings`);
  }
  if (value.length > 0 && !value.some(arg => arg.includes(placeholder))) {
    throw fail('config-invalid', `${where} must contain ${placeholder}, or be empty when the executor has no such flag`);
  }
}

function mergeExecutor(id, base, override, where) {
  if (!isObject(override)) throw fail('config-invalid', `${where} must be an object`);
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    switch (key) {
      case 'command':
        if (typeof value !== 'string' || value.trim() === '') {
          throw fail('config-invalid', `${where}.command must be a non-empty string`);
        }
        merged.command = value;
        break;
      case 'passEnv':
        if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !ENV_NAME.test(name))) {
          throw fail('config-invalid', `${where}.passEnv must list environment variable names`);
        }
        merged.passEnv = [...new Set(value)];
        break;
      case 'timeoutMinutes':
        checkMinutes(value, `${where}.timeoutMinutes`);
        merged.timeoutMinutes = value;
        break;
      case 'extraArgs':
        if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string')) {
          throw fail('config-invalid', `${where}.extraArgs must be a list of strings`);
        }
        merged.extraArgs = [...value];
        break;
      case 'bare':
        if (id !== 'claude' || typeof value !== 'boolean') {
          throw fail('config-invalid', `${where}.bare is a boolean for the claude executor only`);
        }
        merged.bare = value;
        break;
      case 'model':
      case 'effort':
        checkName(value, `${where}.${key}`);
        merged[key] = value;
        break;
      case 'modelArgs':
        checkTemplate(value, '{model}', `${where}.modelArgs`);
        merged.modelArgs = [...value];
        break;
      case 'effortArgs':
        checkTemplate(value, '{effort}', `${where}.effortArgs`);
        merged.effortArgs = [...value];
        break;
      default:
        throw fail('config-invalid', `${where}.${key} is not a known setting`);
    }
  }
  return merged;
}

/** A tier's route: the executor and, optionally, the model and effort to run it with. */
function normalizeRoute(value, where) {
  const route = typeof value === 'string' ? { executor: value } : value;
  if (!isObject(route)) throw fail('config-invalid', `${where} must be an executor name or { executor, model?, effort? }`);
  for (const key of Object.keys(route)) {
    if (!['executor', 'model', 'effort'].includes(key)) throw fail('config-invalid', `${where}.${key} is not a known setting`);
  }
  if (!EXECUTOR_IDS.includes(route.executor)) {
    throw fail('config-invalid', `${where} names unknown executor "${route.executor}"`);
  }
  if (route.model !== undefined) checkName(route.model, `${where}.model`);
  if (route.effort !== undefined) checkName(route.effort, `${where}.effort`);
  return Object.freeze({ ...route });
}

/**
 * Builds the effective configuration from layers, lowest first.
 *
 * Profile selection: AGENTHUB_RELAY_PROFILE; then the files' plannerProfiles
 * entry for the planner; then a profile named by a file; then the built-in
 * plannerProfiles entry; then the default.
 *
 * @param {object} input
 * @param {{ file: string, data: object }[]} input.layers configuration files, lowest first
 * @param {object} [input.env] environment (AGENTHUB_RELAY_PROFILE)
 * @param {string} [input.planner] planner id, see plannerFromName
 */
export function buildConfig({ layers = [], env = {}, planner = 'unknown' } = {}) {
  const profiles = structuredClone(DEFAULT_CONFIG.profiles);
  const executors = structuredClone(DEFAULT_CONFIG.executors);
  const checks = { ...DEFAULT_CONFIG.checks };
  const light = { ...DEFAULT_CONFIG.light };
  const plannerProfiles = {};
  let fileProfile;

  for (const { file, data } of layers) {
    const where = file;
    for (const key of Object.keys(data)) {
      if (!TOP_KEYS.includes(key)) throw fail('config-invalid', `${where}: unknown key "${key}"`);
    }
    if (data.profiles !== undefined) {
      if (!isObject(data.profiles)) throw fail('config-invalid', `${where}: profiles must be an object`);
      for (const [name, mapping] of Object.entries(data.profiles)) {
        if (!isObject(mapping)) throw fail('config-invalid', `${where}: profile "${name}" must be an object`);
        profiles[name] = { ...(profiles[name] ?? {}), ...mapping };
      }
    }
    if (data.plannerProfiles !== undefined) {
      if (!isObject(data.plannerProfiles)) throw fail('config-invalid', `${where}: plannerProfiles must be an object`);
      for (const [id, name] of Object.entries(data.plannerProfiles)) {
        if (!PLANNER_IDS.includes(id)) {
          throw fail('config-invalid', `${where}: plannerProfiles.${id} is not a planner (known: ${PLANNER_IDS.join(', ')})`);
        }
        if (typeof name !== 'string') throw fail('config-invalid', `${where}: plannerProfiles.${id} must be a profile name`);
        plannerProfiles[id] = name;
      }
    }
    if (data.executors !== undefined) {
      if (!isObject(data.executors)) throw fail('config-invalid', `${where}: executors must be an object`);
      for (const [id, override] of Object.entries(data.executors)) {
        if (RESERVED[id]) {
          throw fail('config-invalid', `${where}: executor "${id}" is reserved and cannot be configured`);
        }
        if (!executors[id]) throw fail('config-invalid', `${where}: unknown executor "${id}"`);
        executors[id] = mergeExecutor(id, executors[id], override, `${where}: executors.${id}`);
      }
    }
    if (data.checks !== undefined) {
      if (!isObject(data.checks)) throw fail('config-invalid', `${where}: checks must be an object`);
      for (const [key, value] of Object.entries(data.checks)) {
        if (key === 'shell') {
          if (typeof value !== 'string' || value.trim() === '') throw fail('config-invalid', `${where}: checks.shell must be the path or name of a shell`);
          checks.shell = value;
          continue;
        }
        if (key !== 'timeoutMinutes') throw fail('config-invalid', `${where}: checks.${key} is not a known setting`);
        checkMinutes(value, `${where}: checks.timeoutMinutes`);
        checks.timeoutMinutes = value;
      }
    }
    if (data.light !== undefined) {
      if (!isObject(data.light)) throw fail('config-invalid', `${where}: light must be an object`);
      for (const [key, value] of Object.entries(data.light)) {
        if (!['maxScopeEntries', 'maxChangedFiles'].includes(key)) {
          throw fail('config-invalid', `${where}: light.${key} is not a known setting`);
        }
        if (!Number.isInteger(value) || value < 1 || value > 1000) {
          throw fail('config-invalid', `${where}: light.${key} must be an integer between 1 and 1000`);
        }
        light[key] = value;
      }
    }
    if (data.profile !== undefined) {
      if (typeof data.profile !== 'string') throw fail('config-invalid', `${where}: profile must be a string`);
      fileProfile = data.profile;
    }
  }

  const where = layers.length ? layers[layers.length - 1].file : 'configuration';
  const routesByProfile = {};
  for (const [name, mapping] of Object.entries(profiles)) {
    routesByProfile[name] = {};
    for (const [tier, value] of Object.entries(mapping)) {
      if (!TIERS.includes(tier)) throw fail('config-invalid', `${where}: profile "${name}" names unknown tier "${tier}"`);
      routesByProfile[name][tier] = normalizeRoute(value, `${where}: profile "${name}" ${tier}`);
    }
  }
  for (const [id, name] of Object.entries(plannerProfiles)) {
    if (!profiles[name]) throw fail('config-invalid', `plannerProfiles.${id} names undefined profile "${name}"`);
  }

  const id = PLANNER_IDS.includes(planner) ? planner : 'unknown';
  let profile;
  let profileReason;
  if (env.AGENTHUB_RELAY_PROFILE) {
    profile = env.AGENTHUB_RELAY_PROFILE;
    profileReason = 'AGENTHUB_RELAY_PROFILE';
  } else if (plannerProfiles[id]) {
    profile = plannerProfiles[id];
    profileReason = `plannerProfiles.${id} in the configuration file`;
  } else if (fileProfile !== undefined) {
    profile = fileProfile;
    profileReason = 'profile in the configuration file';
  } else if (DEFAULT_CONFIG.plannerProfiles[id]) {
    profile = DEFAULT_CONFIG.plannerProfiles[id];
    profileReason = `built-in default for a ${id} planner`;
  } else {
    profile = DEFAULT_CONFIG.profile;
    profileReason = 'built-in default';
  }
  const routes = routesByProfile[profile];
  if (!routes) throw fail('config-invalid', `Profile "${profile}" is not defined (known: ${Object.keys(profiles).join(', ')})`);
  for (const tier of TIERS) {
    if (!routes[tier]) throw fail('config-invalid', `Profile "${profile}" does not map the ${tier} tier`);
  }
  const mapping = Object.fromEntries(TIERS.map(tier => [tier, routes[tier].executor]));

  return Object.freeze({
    source: layers.length ? layers[layers.length - 1].file : null,
    sources: layers.map(layer => layer.file),
    planner: id,
    profile,
    profileReason,
    mapping: Object.freeze(mapping),
    routes: Object.freeze({ ...routes }),
    profiles: Object.freeze(profiles),
    plannerProfiles: Object.freeze({ ...DEFAULT_CONFIG.plannerProfiles, ...plannerProfiles }),
    executors: Object.freeze(executors),
    checks: Object.freeze(checks),
    light: Object.freeze(light),
  });
}

/** The configuration files that apply to a project root, lowest first. */
export function configLayers({ root, env = process.env } = {}) {
  const layers = [];
  const user = userConfigPath(env);
  const project = root ? configPath(root, env) : null;
  for (const file of [user, project]) {
    if (!file || (layers.length && layers[0].file === file)) continue;
    const data = readFileConfig(file);
    if (data) layers.push({ file, data });
  }
  return layers;
}

/** Loads the effective configuration for a project root and planner. */
export function loadConfig({ root, env = process.env, planner = 'unknown' } = {}) {
  return buildConfig({ layers: configLayers({ root, env }), env, planner });
}

/**
 * Parses a route value as written on a command line: `executor`,
 * `executor:model`, `executor@effort` or `executor:model@effort`.
 */
export function parseRoute(text) {
  const match = /^([a-z]+)(?::([^@]+))?(?:@(.+))?$/.exec(String(text ?? '').trim());
  if (!match) throw fail('invalid-value', `"${text}" is not executor[:model][@effort]`);
  const [, executor, model, effort] = match;
  if (!model && !effort) return executor;
  return { executor, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

const SETTABLE = [
  { pattern: /^profile$/, parse: value => value },
  { pattern: /^plannerProfiles\.([a-z]+)$/, parse: value => value },
  { pattern: /^profiles\.([A-Za-z0-9_-]+)\.(deep|light|review)$/, parse: parseRoute },
  { pattern: /^executors\.([a-z]+)\.(model|effort|command)$/, parse: value => value },
  { pattern: /^executors\.([a-z]+)\.timeoutMinutes$/, parse: value => Number(value) },
  { pattern: /^checks\.shell$/, parse: value => value },
];

/** The keys `config set` and `config unset` accept. */
export const SETTABLE_KEYS = Object.freeze([
  'profile',
  'plannerProfiles.<planner>',
  'profiles.<name>.<deep|light|review>',
  'executors.<codex|claude|dsh>.<model|effort|command|timeoutMinutes>',
  'checks.shell',
]);

/**
 * Sets or removes one setting in a configuration file. The new file is
 * validated as a layer over the built-in defaults before it replaces the old
 * one, so an invalid value leaves the file untouched. `layersBelow` are the
 * files under this one (the user file, when writing the project file).
 *
 * @returns {{ file: string, key: string, value: unknown, removed: boolean }}
 */
export function writeSetting({ file, key, value, unset = false, layersBelow = [] }) {
  const rule = SETTABLE.find(entry => entry.pattern.test(key));
  if (!rule) throw fail('invalid-key', `"${key}" cannot be set here (settable: ${SETTABLE_KEYS.join(', ')})`);
  const data = readFileConfig(file) ?? {};
  const parts = key.split('.');
  let node = data;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(node[part])) {
      if (unset) return { file, key, value: undefined, removed: false };
      node[part] = {};
    }
    node = node[part];
  }
  const last = parts[parts.length - 1];
  let parsed;
  if (unset) {
    if (!(last in node)) return { file, key, value: undefined, removed: false };
    delete node[last];
  } else {
    parsed = rule.parse(value);
    node[last] = parsed;
  }
  buildConfig({ layers: [...layersBelow, { file, data }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameWithRetry(temp, file);
  return { file, key, value: parsed, removed: unset };
}
