// What differs between POSIX and Windows, in one place: finding and starting
// a command, ending a process tree, the shell checks run in, and replacing a
// file another process may be reading. Every function takes the platform (and
// its other inputs) as parameters, so the Windows branch is testable anywhere.

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
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

function expand(value, env, platform, here) {
  const withDir = here === undefined ? value : value.replace(/%~dp0/gi, here);
  return withDir.replace(/%([A-Za-z_][\w()]*)%/g, (whole, name) => envValue(env, name, platform) ?? whole);
}

/**
 * A launcher shim that sets some variables and then starts a program by its
 * absolute path, as DSH Desktop's dsh.cmd does:
 *   if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"
 *   set "ELECTRON_RUN_AS_NODE=1"
 *   "E:\...\DSH Desktop.exe" --expose-internals "E:\...\desktop-cli.js" %*
 * Newer DSH installs chain two such scripts (`call "E:\...\dsh.cmd" %*`) and
 * pick the entry script with `if [not] exist "..." (` blocks and %~dp0 (the
 * shim's own folder, which needs `shimFile`); those are followed too, a chain
 * as `{ chain, env }`. Returns { file, prefixArgs, env } or null when the shim
 * has another shape: unknown variables are never expanded blindly.
 */
export function launcherShim(text, { env = process.env, platform = process.platform, shimFile, exists = fs.existsSync } = {}) {
  const assigned = {};
  const here = shimFile === undefined ? undefined : `${path.win32.dirname(shimFile)}\\`;
  const value = raw => expand(raw, { ...env, ...assigned }, platform, here);
  const holds = (negated, file) => {
    const target = value(file);
    if (/%/.test(target)) return null;
    return negated ? !exists(target) : exists(target);
  };
  const blocks = [];
  const active = () => blocks.every(Boolean);
  let launch = null;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim().replace(/^@/, '');
    if (line === '' || /^rem(\s|$)/i.test(line) || /^::/.test(line)) continue;
    const open = /^if (not )?exist "([^"]+)" \($/i.exec(line);
    if (open) {
      const result = holds(Boolean(open[1]), open[2]);
      if (result === null) return null;
      blocks.push(result);
      continue;
    }
    if (line === ')') {
      if (!blocks.length) return null;
      blocks.pop();
      continue;
    }
    if (!active()) continue;
    const guardedSet = /^if (not )?exist "([^"]+)" (set ".*")$/i.exec(line);
    if (guardedSet) {
      const result = holds(Boolean(guardedSet[1]), guardedSet[2]);
      if (result === null) return null;
      if (!result) continue;
      line = guardedSet[3];
    }
    const set = /^(?:if not defined ([A-Za-z_]\w*) )?set "([A-Za-z_]\w*)=([^"]*)"$/i.exec(line);
    if (set) {
      const [, guard, name, raw] = set;
      if (guard && (envValue(env, guard, platform) !== undefined || assigned[guard] !== undefined)) continue;
      assigned[name] = value(raw);
      continue;
    }
    if (!line.endsWith('%*')) continue;
    const chained = /^call "([^"]+\.(?:cmd|bat))" %\*$/i.exec(line);
    if (chained) {
      const next = value(chained[1]);
      if (/%/.test(next) || !path.win32.isAbsolute(next)) return null;
      return { chain: next, env: assigned };
    }
    const expanded = line.replace(/"([^"]*)"/g, (whole, inner) => `"${value(inner)}"`);
    if (/%(?!\*$)/.test(expanded.replace(/%\*$/, ''))) return null;
    const call = /^"([^"%]+\.exe)"((?:\s+(?:"[^"%]*"|[^\s"%]+))*)\s+%\*$/i.exec(expanded);
    if (!call) return null;
    const args = [...call[2].matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
    launch = { file: path.win32.normalize(call[1]), args: args.map(arg => (/^[A-Za-z]:\\/.test(arg) ? path.win32.normalize(arg) : arg)) };
    break; // variables set after the launch do not reach the program
  }
  if (!launch || !(path.win32.isAbsolute(launch.file) || path.posix.isAbsolute(launch.file))) return null;
  return { file: launch.file, prefixArgs: launch.args, env: assigned };
}

/** A launcher shim, following `call` chains (at most a few) and merging the variables each sets. */
function followLauncher(shimFile, text, { env, platform }) {
  let merged = {};
  let file = shimFile;
  let body = text;
  for (let depth = 0; depth < 4; depth += 1) {
    const result = launcherShim(body, { env: { ...env, ...merged }, platform, shimFile: file });
    if (!result) return null;
    if (!result.chain) return { ...result, env: { ...merged, ...result.env } };
    merged = { ...merged, ...result.env };
    if (!isFile(result.chain)) return null;
    file = result.chain;
    body = fs.readFileSync(file, 'utf8');
  }
  return null;
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
  // An Electron launcher (a desktop app's CLI) or a chain of shims is read as
  // a launcher first: its %~dp0 path is the app's .exe, not the program.
  if (/^\s*@?call\s+"/im.test(text) || /ELECTRON_RUN_AS_NODE/i.test(text)) {
    const launcher = followLauncher(found, text, { env, platform });
    if (launcher && isFile(launcher.file)) return { ...launcher, via: 'shim-exe', path: found };
  }
  const target = shimTarget(found, text);
  if (!target) {
    const launcher = launcherShim(text, { env, platform, shimFile: found });
    if (launcher && !launcher.chain && isFile(launcher.file)) return { ...launcher, via: 'shim-exe', path: found };
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

/** The only links a takeover opens: Codex Desktop threads, with an id that holds nothing a shell or URL parser would read. */
export const OPENABLE_URL = /^codex:\/\/threads\/[A-Za-z0-9._:-]{1,200}$/;

/**
 * Variables of the process asking for a takeover that must not reach the app
 * it opens: Claude Code refuses to start inside what it takes for another
 * Claude Code session, and an executor marker would switch the relay's own
 * mod off in the session being opened.
 */
function launchEnv(env) {
  const clean = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_') || name.startsWith('AGENTHUB_RELAY_')) continue;
    if (name === 'CODEX_THREAD_ID' || name === 'CODEXHOST_THREAD_ID') continue;
    clean[name] = value;
  }
  return clean;
}

/**
 * Opens a takeover target without a shell: `{ url }` (an OPENABLE_URL, handed
 * to rundll32's URL handler on Windows, `open` on macOS, `xdg-open` elsewhere)
 * or `{ argv, cwd }` (a command the relay built, started detached). Resolves
 * `{ ok, pid?, error? }` once the program started or failed to.
 */
export function openDetached(target, { env = process.env, platform = process.platform, spawn = nodeSpawn } = {}) {
  let file;
  let args;
  let cwd;
  let childEnv = launchEnv(env);
  if (target.url !== undefined) {
    if (typeof target.url !== 'string' || !OPENABLE_URL.test(target.url)) {
      return Promise.resolve({ ok: false, error: `Refusing to open "${target.url}": not a codex://threads/<id> link` });
    }
    if (platform === 'win32') [file, args] = ['rundll32.exe', ['url.dll,FileProtocolHandler', target.url]];
    else if (platform === 'darwin') [file, args] = ['open', [target.url]];
    else [file, args] = ['xdg-open', [target.url]];
  } else {
    let resolved;
    try {
      resolved = resolveCommand(target.argv[0], { env, platform });
    } catch (err) {
      return Promise.resolve({ ok: false, error: err.message });
    }
    if (!resolved) return Promise.resolve({ ok: false, error: `"${target.argv[0]}" cannot be found` });
    file = resolved.file;
    args = [...resolved.prefixArgs, ...target.argv.slice(1)];
    cwd = target.cwd;
    childEnv = { ...childEnv, ...(resolved.env ?? {}) };
  }
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(file, args, { cwd, env: childEnv, detached: true, stdio: 'ignore', windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    child.once('error', err => resolve({ ok: false, error: err.message }));
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, pid: child.pid });
    });
  });
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reads a file another process may replace at the same moment. Windows reports
 * a reader that loses that race as EPERM, EBUSY or EACCES for a moment, so
 * those errors are retried; a missing file or any other error is immediate.
 */
export function readFileWithRetry(file, { encoding = 'utf8', fsImpl = fs, attempts = 10, delayMs = 15 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fsImpl.readFileSync(file, { encoding });
    } catch (err) {
      if (!RETRYABLE_RENAME.has(err.code) || attempt >= attempts) throw err;
      pause(delayMs);
    }
  }
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
