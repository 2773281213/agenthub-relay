// Finding an executor that is installed but not on PATH: a desktop app's
// bundled CLI (Codex Desktop ships codex.exe), or a per-user install folder a
// process started before the install does not have on its PATH (agy, dsh,
// claude). Only the built-in command name is searched for this way; a command
// the user configured is used as written and never replaced by another
// installation. Install folders are taken from the given environment's home
// and app-data variables: an environment without them searches nothing.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { envValue, resolveCommand } from './platform.mjs';

/** The command names discovery applies to; any other configured command is used as is. */
export const DEFAULT_COMMANDS = Object.freeze({ codex: 'codex', claude: 'claude', dsh: 'dsh', agy: 'agy' });

/** Where Windows records the install folder of each packaged (MSIX/AppX) app. */
const APPX_PACKAGES_KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
const CACHE_MS = 10 * 60_000;
const cache = new Map();

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Files named `name` directly in `dir` or in its immediate subfolders, newest first. */
function newestIn(dir, name) {
  const found = [path.join(dir, name)];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(path.join(dir, entry.name, name));
    }
  } catch {
    return [];
  }
  return found.filter(isFile).sort((a, b) => mtime(b) - mtime(a));
}

/**
 * The install folders of Codex Desktop's package (Windows), read from the
 * registry with reg.exe; `C:\Program Files\WindowsApps` itself cannot be listed.
 */
export function codexPackageRoots({ spawnSync = nodeSpawnSync } = {}) {
  const run = (args) => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  const keys = run(['query', APPX_PACKAGES_KEY, '/f', 'OpenAI.Codex', '/k']);
  if (keys.error || keys.status !== 0 || typeof keys.stdout !== 'string') return [];
  const roots = [];
  for (const line of keys.stdout.split(/\r?\n/)) {
    const key = line.trim();
    if (!/\\Packages\\OpenAI\.Codex_/i.test(key)) continue;
    const value = run(['query', key, '/v', 'PackageRootFolder']);
    const match = /PackageRootFolder\s+REG_\w+\s+(.+)$/m.exec(value.stdout ?? '');
    if (match) roots.push(match[1].trim());
  }
  // Newest package version first: the folder names end in _<version>_<arch>__<publisher>.
  return roots.sort().reverse();
}

/** The install locations tried for an executor, most likely first. */
export function installCandidates(id, { env = process.env, platform = process.platform, spawnSync = nodeSpawnSync } = {}) {
  const windows = platform === 'win32';
  const home = envValue(env, windows ? 'USERPROFILE' : 'HOME', platform) ?? envValue(env, 'HOME', platform);
  const localAppData = windows ? envValue(env, 'LOCALAPPDATA', platform) : undefined;
  const fromHome = (...parts) => (home ? [path.join(home, ...parts)] : []);
  switch (id) {
    case 'codex':
      if (windows) {
        return [
          ...(localAppData ? codexPackageRoots({ spawnSync }).map(root => path.join(root, 'app', 'resources', 'codex.exe')) : []),
          ...(localAppData ? newestIn(path.join(localAppData, 'OpenAI', 'Codex', 'bin'), 'codex.exe') : []),
        ];
      }
      if (platform === 'darwin') {
        return ['/Applications/Codex.app/Contents/Resources/codex', ...fromHome('Applications', 'Codex.app', 'Contents', 'Resources', 'codex')];
      }
      return [];
    case 'claude':
      return windows ? fromHome('.local', 'bin', 'claude.exe') : [...fromHome('.local', 'bin', 'claude'), ...fromHome('.claude', 'local', 'claude')];
    case 'agy':
      return windows
        ? [...(localAppData ? [path.join(localAppData, 'agy', 'bin', 'agy.exe')] : []), ...fromHome('.local', 'bin', 'agy.exe')]
        : fromHome('.local', 'bin', 'agy');
    case 'dsh':
      return windows ? [...fromHome('.dsh', 'bin', 'dsh.cmd'), ...fromHome('.dsh', 'bin', 'dsh.exe')] : fromHome('.dsh', 'bin', 'dsh');
    default:
      return [];
  }
}

/**
 * How to start executor `id` whose configured command is `command`:
 * `{ command, resolved, discovered, problem? }`. `command` is what to put in
 * the argv (the configured one, or the absolute path discovery found), and
 * `resolved` what platform.resolveCommand made of it, or null when nothing was
 * found. A configured command that cannot run is reported, not replaced.
 */
export function locateExecutor(id, command, { env = process.env, platform = process.platform, spawnSync = nodeSpawnSync, now = Date.now() } = {}) {
  let resolved = null;
  try {
    resolved = resolveCommand(command, { env, platform });
  } catch (err) {
    return { command, resolved: null, discovered: false, problem: err.message };
  }
  if (resolved || command !== DEFAULT_COMMANDS[id] || envValue(env, 'AGENTHUB_RELAY_DISCOVERY', platform) === 'off') {
    return { command, resolved, discovered: false };
  }
  const key = JSON.stringify([id, platform, envValue(env, 'USERPROFILE', platform), envValue(env, 'HOME', platform), envValue(env, 'LOCALAPPDATA', platform)]);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS && (hit.found === null || isFile(hit.found.command))) return hit.found ?? { command, resolved: null, discovered: false };
  let found = null;
  for (const candidate of installCandidates(id, { env, platform, spawnSync })) {
    try {
      const located = resolveCommand(candidate, { env, platform });
      if (located) {
        found = { command: candidate, resolved: located, discovered: true };
        break;
      }
    } catch {
      // a shim discovery cannot run: try the next place
    }
  }
  cache.set(key, { at: now, found });
  return found ?? { command, resolved: null, discovered: false };
}

/** The command to run for executor `id` under `config`: discovered when the default name is not on PATH. */
export function executorCommand(id, config, options = {}) {
  const configured = config?.executors?.[id]?.command ?? DEFAULT_COMMANDS[id] ?? id;
  return locateExecutor(id, configured, options).command;
}

/** Forgets what discovery found (tests, or after an install). */
export function clearDiscoveryCache() {
  cache.clear();
}
