// What differs between POSIX and Windows, in one place: finding and starting
// a command, ending a process tree, the shell checks run in, and replacing a
// file another process may be reading. Every function takes the platform (and
// its other inputs) as parameters, so the Windows branch is testable anywhere.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = /\.(?:c|m)?js$/i;
const WINDOWS_SHIMS = new Set(['.cmd', '.bat']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** An environment variable by name; Windows names are case-insensitive. */
export function envValue(env, name, platform = process.platform) {
  if (env[name] !== undefined) return env[name];
  if (platform !== 'win32') return undefined;
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Where `command` is found: as given when it names a path, else on PATH (with PATHEXT on Windows). */
export function locateCommand(command, { env = process.env, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const hasDir = windows ? /[\\/]/.test(command) : command.includes('/');
  const exts = windows
    ? (envValue(env, 'PATHEXT', platform) || DEFAULT_PATHEXT).split(';').filter(Boolean).map(ext => ext.toLowerCase())
    : [''];
  const candidates = base => {
    if (!windows) return [base];
    const own = path.extname(base).toLowerCase();
    return own && exts.includes(own) ? [base] : [base, ...exts.map(ext => `${base}${ext}`)];
  };
  const usable = file => (windows ? isFile(file) : isExecutable(file));
  if (hasDir) return candidates(command).find(usable) ?? null;
  const dirs = (envValue(env, 'PATH', platform) ?? '').split(windows ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const found = candidates(path.join(dir, command)).find(usable);
    if (found) return found;
  }
  return null;
}

/**
 * The program an npm or pnpm .cmd shim runs: the last quoted path relative to
 * the shim's folder (%~dp0 or %dp0%) that is not node.exe itself.
 */
export function shimTarget(shimFile, text = fs.readFileSync(shimFile, 'utf8')) {
  const targets = [];
  for (const match of text.matchAll(/"(?:%~dp0|%dp0%)\\?([^"%]+)"/gi)) {
    const relative = match[1].trim();
    if (!relative || /(?:^|[\\/])node(?:\.exe)?$/i.test(relative)) continue;
    targets.push(relative);
  }
  const relative = targets.at(-1);
  if (!relative) return null;
  return path.join(path.dirname(shimFile), ...relative.split(/[\\/]+/).filter(Boolean));
}

function expand(value, env, platform) {
  return value.replace(/%([A-Za-z_][\w()]*)%/g, (whole, name) => envValue(env, name, platform) ?? whole);
}

/**
 * A launcher shim that sets some variables and then starts a program by its
 * absolute path, as DSH Desktop's dsh.cmd does:
 *   if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"
 *   set "ELECTRON_RUN_AS_NODE=1"
 *   "E:\...\DSH Desktop.exe" --expose-internals "E:\...\desktop-cli.js" %*
 * Returns { file, prefixArgs, env } or null when the shim has another shape.
 */
export function launcherShim(text, { env = process.env, platform = process.platform } = {}) {
  const assigned = {};
  let launch = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^@/, '');
    const set = /^(?:if not defined ([A-Za-z_]\w*) )?set "([A-Za-z_]\w*)=([^"]*)"$/i.exec(line);
    if (set) {
      const [, guard, name, value] = set;
      if (guard && (envValue(env, guard, platform) !== undefined || assigned[guard] !== undefined)) continue;
      assigned[name] = expand(value, { ...env, ...assigned }, platform);
      continue;
    }
    if (!line.endsWith('%*')) continue;
    const call = /^"([^"%]+\.exe)"((?:\s+(?:"[^"%]*"|[^\s"%]+))*)\s+%\*$/i.exec(line);
    if (!call) return null;
    const args = [...call[2].matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
    launch = { file: call[1], args };
    break; // variables set after the launch do not reach the program
  }
  if (!launch || !(path.win32.isAbsolute(launch.file) || path.posix.isAbsolute(launch.file))) return null;
  return { file: launch.file, prefixArgs: launch.args, env: assigned };
}

/**
 * How to start `command`: `{ file, prefixArgs, via, path, env? }`, or null when it
 * cannot be found. A .js file runs with this Node.js. On Windows a .cmd/.bat
 * shim is resolved to the program it wraps, so arguments reach it verbatim
 * instead of through cmd.exe; a shim that cannot be read that way fails
 * closed with `windows-shim-unsupported`.
 */
export function resolveCommand(command, { env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  if (SCRIPT.test(command)) {
    const script = path.resolve(command);
    return isFile(script) ? { file: execPath, prefixArgs: [script], via: 'node-script', path: script } : null;
  }
  const found = locateCommand(command, { env, platform });
  if (!found) return null;
  if (platform !== 'win32' || !WINDOWS_SHIMS.has(path.extname(found).toLowerCase())) {
    return { file: found, prefixArgs: [], via: 'direct', path: found };
  }
  const text = fs.readFileSync(found, 'utf8');
  const target = shimTarget(found, text);
  if (!target) {
    const launcher = launcherShim(text, { env, platform });
    if (launcher && isFile(launcher.file)) return { ...launcher, via: 'shim-exe', path: found };
  }
  if (!target || !isFile(target)) {
    throw fail(
      'windows-shim-unsupported',
      `${found} is a cmd.exe script that agenthub-relay cannot run safely; set the executor's "command" to the .exe or the .js file it starts`,
    );
  }
  if (path.extname(target).toLowerCase() === '.exe') return { file: target, prefixArgs: [], via: 'shim-exe', path: found };
  return { file: execPath, prefixArgs: [target], via: 'shim-node', path: found };
}

/** Spawn options for an executor or check: its own process group on POSIX, no console window on Windows. */
export function childSpawnOptions(platform = process.platform) {
  return platform === 'win32' ? { detached: false, windowsHide: true } : { detached: true };
}

/** Spawn options for the worker, which must outlive the process that starts it. */
export function workerSpawnOptions(platform = process.platform) {
  return platform === 'win32' ? { detached: true, windowsHide: true } : { detached: true };
}

/**
 * Ends `pid` and everything it started. POSIX signals the process group the
 * child leads; Windows has none, so taskkill ends the tree (always forced).
 * Returns whether anything was signalled.
 */
export function killTree(pid, { signal = 'SIGTERM', platform = process.platform, spawnSync = nodeSpawnSync } = {}) {
  if (!pid) return false;
  if (platform === 'win32') {
    const run = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return run.status === 0;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** The `shell` spawn option for checks: the configured shell, else the platform's (/bin/sh or cmd.exe). */
export function checkShell(configured) {
  return typeof configured === 'string' && configured.trim() !== '' ? configured : true;
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replaces `to` with `from`. Windows refuses while another process has the
 * target open (a reader of job.json, an antivirus scan), so those errors are
 * retried for about a second before giving up.
 */
export function renameWithRetry(from, to, { fsImpl = fs, attempts = 20, delayMs = 50 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fsImpl.renameSync(from, to);
      return attempt;
    } catch (err) {
      if (!RETRYABLE_RENAME.has(err.code) || attempt >= attempts) throw err;
      pause(delayMs);
    }
  }
}
