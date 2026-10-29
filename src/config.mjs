// Configuration of the hub: which executor each tier goes to, and how each
// executor is run. Built-in defaults are merged with an optional JSON file.
// Planner-neutral: nothing here assumes which agent is planning.

import fs from 'node:fs';
import path from 'node:path';

export const TIERS = Object.freeze(['deep', 'light', 'review']);

/** Tiers whose executors may write (inside their own worktree). */
export const WRITE_TIERS = Object.freeze(new Set(['deep', 'light']));

/** Executors with an adapter in v0.1 and the reserved ones that fail closed. */
export const EXECUTOR_IDS = Object.freeze(['codex', 'claude', 'dsh', 'agy', 'acp']);

/**
 * Reserved executors cannot be enabled by configuration in v0.1: dispatching
 * to them fails closed with this reason.
 */
export const RESERVED = Object.freeze({
  agy: 'Antigravity (agy) is reserved in agenthub-relay v0.1; its headless adapter is planned for v0.2.',
  acp: 'The generic ACP executor is reserved in agenthub-relay v0.1; it is planned for v0.2.',
});

export const DEFAULT_CONFIG = Object.freeze({
  profile: 'thread16',
  profiles: {
    // The split proposed in linux.do topic 3028918: complex work to Codex,
    // simple and clear work to DeepSeek (V4 Flash, through DeepSeek Harness),
    // read-only review to Claude Code.
    thread16: { deep: 'codex', light: 'dsh', review: 'claude' },
    // Example for a Codex planner: Claude Code takes deep work, Codex reviews.
    'codex-planner': { deep: 'claude', light: 'dsh', review: 'codex' },
  },
  executors: {
    codex: { command: 'codex', passEnv: [], timeoutMinutes: 60, extraArgs: [] },
    claude: { command: 'claude', passEnv: [], timeoutMinutes: 45, extraArgs: [], bare: false },
    dsh: { command: 'dsh', passEnv: [], timeoutMinutes: 30, extraArgs: [] },
  },
  checks: { timeoutMinutes: 10 },
  light: { maxScopeEntries: 10, maxChangedFiles: 10 },
});

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MINUTES = 24 * 60;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Where the optional config file lives for a project root. */
export function configPath(root, env = process.env) {
  const named = env.AGENTHUB_RELAY_CONFIG;
  if (named) return path.resolve(root, named);
  return path.join(root, '.agenthub', 'config.json');
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
      default:
        throw fail('config-invalid', `${where}.${key} is not a known setting`);
    }
  }
  return merged;
}

/**
 * Loads the effective configuration for a project root.
 *
 * Profile selection: AGENTHUB_RELAY_PROFILE, then the file's `profile`, then
 * the default. Reserved executors stay reserved whatever the file says.
 */
export function loadConfig({ root, env = process.env } = {}) {
  const file = root ? configPath(root, env) : null;
  const fromFile = file ? readFileConfig(file) : null;
  const source = fromFile ? file : null;
  const where = source ?? 'configuration';

  const profiles = structuredClone(DEFAULT_CONFIG.profiles);
  const executors = structuredClone(DEFAULT_CONFIG.executors);
  const checks = { ...DEFAULT_CONFIG.checks };
  const light = { ...DEFAULT_CONFIG.light };
  let profile = DEFAULT_CONFIG.profile;

  if (fromFile) {
    for (const key of Object.keys(fromFile)) {
      if (!['profile', 'profiles', 'executors', 'checks', 'light'].includes(key)) {
        throw fail('config-invalid', `${where}: unknown key "${key}"`);
      }
    }
    if (fromFile.profiles !== undefined) {
      if (!isObject(fromFile.profiles)) throw fail('config-invalid', `${where}: profiles must be an object`);
      for (const [name, mapping] of Object.entries(fromFile.profiles)) {
        if (!isObject(mapping)) throw fail('config-invalid', `${where}: profile "${name}" must be an object`);
        profiles[name] = { ...(profiles[name] ?? {}), ...mapping };
      }
    }
    if (fromFile.executors !== undefined) {
      if (!isObject(fromFile.executors)) throw fail('config-invalid', `${where}: executors must be an object`);
      for (const [id, override] of Object.entries(fromFile.executors)) {
        if (RESERVED[id]) {
          throw fail('config-invalid', `${where}: executor "${id}" is reserved in v0.1 and cannot be configured`);
        }
        if (!executors[id]) throw fail('config-invalid', `${where}: unknown executor "${id}"`);
        executors[id] = mergeExecutor(id, executors[id], override, `${where}: executors.${id}`);
      }
    }
    if (fromFile.checks !== undefined) {
      if (!isObject(fromFile.checks)) throw fail('config-invalid', `${where}: checks must be an object`);
      for (const [key, value] of Object.entries(fromFile.checks)) {
        if (key !== 'timeoutMinutes') throw fail('config-invalid', `${where}: checks.${key} is not a known setting`);
        checkMinutes(value, `${where}: checks.timeoutMinutes`);
        checks.timeoutMinutes = value;
      }
    }
    if (fromFile.light !== undefined) {
      if (!isObject(fromFile.light)) throw fail('config-invalid', `${where}: light must be an object`);
      for (const [key, value] of Object.entries(fromFile.light)) {
        if (!['maxScopeEntries', 'maxChangedFiles'].includes(key)) {
          throw fail('config-invalid', `${where}: light.${key} is not a known setting`);
        }
        if (!Number.isInteger(value) || value < 1 || value > 1000) {
          throw fail('config-invalid', `${where}: light.${key} must be an integer between 1 and 1000`);
        }
        light[key] = value;
      }
    }
    if (fromFile.profile !== undefined) {
      if (typeof fromFile.profile !== 'string') throw fail('config-invalid', `${where}: profile must be a string`);
      profile = fromFile.profile;
    }
  }
  if (env.AGENTHUB_RELAY_PROFILE) profile = env.AGENTHUB_RELAY_PROFILE;

  for (const [name, mapping] of Object.entries(profiles)) {
    for (const [tier, executor] of Object.entries(mapping)) {
      if (!TIERS.includes(tier)) throw fail('config-invalid', `${where}: profile "${name}" names unknown tier "${tier}"`);
      if (!EXECUTOR_IDS.includes(executor)) {
        throw fail('config-invalid', `${where}: profile "${name}" maps ${tier} to unknown executor "${executor}"`);
      }
    }
  }
  const mapping = profiles[profile];
  if (!mapping) throw fail('config-invalid', `Profile "${profile}" is not defined (known: ${Object.keys(profiles).join(', ')})`);
  for (const tier of TIERS) {
    if (!mapping[tier]) throw fail('config-invalid', `Profile "${profile}" does not map the ${tier} tier`);
  }

  return Object.freeze({
    source,
    profile,
    mapping: Object.freeze({ ...mapping }),
    profiles: Object.freeze(profiles),
    executors: Object.freeze(executors),
    checks: Object.freeze(checks),
    light: Object.freeze(light),
  });
}
