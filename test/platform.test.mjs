// Platform differences, with the Windows branch exercised on any OS by
// passing platform: 'win32': finding commands through PATHEXT, reading npm
// and pnpm .cmd shims, ending process trees, check shells and retried renames.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { spawnArgv } from '../src/executors.mjs';
import { checkShell, childSpawnOptions, envValue, killTree, launcherShim, renameWithRetry, resolveCommand, shimTarget, workerSpawnOptions } from '../src/platform.mjs';
import { tempDir } from './helpers.mjs';

// The shim npm (cmd-shim) writes for a global package bin.
const NPM_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r
`;

// The shim pnpm writes.
const PNPM_SHIM = `@SETLOCAL\r
@IF NOT DEFINED NODE_PATH (\r
  @SET "NODE_PATH=C:\\pnpm\\global\\5\\node_modules"\r
)\r
@IF EXIST "%~dp0\\node.exe" (\r
  "%~dp0\\node.exe"  "%~dp0\\..\\dsh\\dist\\cli.js" %*\r
) ELSE (\r
  @SET PATHEXT=%PATHEXT:;.JS;=;%\r
  node  "%~dp0\\..\\dsh\\dist\\cli.js" %*\r
)\r
`;

function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function windowsLayout() {
  const { dir, cleanup } = tempDir('agenthub-win-');
  const npmBin = path.join(dir, 'npm');
  const pnpmBin = path.join(dir, 'pnpm', 'bin');
  const localBin = path.join(dir, 'local');
  write(path.join(npmBin, 'codex.cmd'), NPM_SHIM);
  write(path.join(npmBin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
  write(path.join(pnpmBin, 'dsh.cmd'), PNPM_SHIM);
  write(path.join(dir, 'pnpm', 'dsh', 'dist', 'cli.js'), '');
  write(path.join(localBin, 'claude.exe'), '');
  write(path.join(localBin, 'odd.cmd'), '@echo off\r\ncall something-else %*\r\n');
  write(path.join(localBin, 'gone.cmd'), NPM_SHIM.replace('@openai\\codex\\bin\\codex.js', 'missing\\x.js'));
  // Windows keeps the PATH variable as "Path".
  const env = { Path: [npmBin, pnpmBin, localBin].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  return { dir, env, npmBin, pnpmBin, localBin, cleanup };
}

test('on Windows an npm or pnpm .cmd shim resolves to node and the script it wraps', () => {
  const { dir, env, npmBin, pnpmBin, cleanup } = windowsLayout();
  try {
    const opts = { env, platform: 'win32', execPath: 'C:\\node\\node.exe' };
    const codex = resolveCommand('codex', opts);
    assert.deepEqual(codex, {
      file: 'C:\\node\\node.exe',
      prefixArgs: [path.join(npmBin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')],
      via: 'shim-node',
      path: path.join(npmBin, 'codex.cmd'),
    });
    const dsh = resolveCommand('dsh', opts);
    assert.equal(dsh.via, 'shim-node');
    assert.deepEqual(dsh.prefixArgs, [path.join(dir, 'pnpm', 'dsh', 'dist', 'cli.js')]);
    assert.equal(dsh.path, path.join(pnpmBin, 'dsh.cmd'), 'PATHEXT entries such as .CMD match lower-case files');
  } finally {
    cleanup();
  }
});

test('on Windows an .exe starts directly; unreadable shims fail closed with a hint', () => {
  const { env, localBin, cleanup } = windowsLayout();
  try {
    const opts = { env, platform: 'win32' };
    assert.deepEqual(resolveCommand('claude', opts), { file: path.join(localBin, 'claude.exe'), prefixArgs: [], via: 'direct', path: path.join(localBin, 'claude.exe') });
    for (const name of ['odd', 'gone']) {
      assert.throws(() => resolveCommand(name, opts), err => err.code === 'windows-shim-unsupported' && /"command"/.test(err.message));
    }
    assert.equal(resolveCommand('nowhere', opts), null);
    assert.equal(resolveCommand('codex', { env: { Path: '' }, platform: 'win32' }), null);
  } finally {
    cleanup();
  }
});

test('shim parsing skips node.exe and reads both %dp0% and %~dp0 forms', () => {
  assert.equal(shimTarget('C:/bin/codex.cmd', NPM_SHIM), path.join('C:/bin', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  assert.equal(shimTarget('/p/bin/dsh.cmd', PNPM_SHIM), path.join('/p/bin', '..', 'dsh', 'dist', 'cli.js'));
  assert.equal(shimTarget('/x/odd.cmd', '@echo off\r\nnode "%~dp0\\node.exe"\r\n'), null);
});

test('a .js command runs with this Node.js; POSIX keeps the plain PATH lookup', () => {
  const { dir, cleanup } = tempDir();
  try {
    const script = path.join(dir, 'agent.mjs');
    write(script, '');
    assert.deepEqual(resolveCommand(script, { execPath: '/usr/bin/node' }), { file: '/usr/bin/node', prefixArgs: [script], via: 'node-script', path: script });
    const tool = path.join(dir, 'bin', 'tool');
    write(tool, '#!/bin/sh\n');
    fs.chmodSync(tool, 0o755);
    write(path.join(dir, 'bin', 'plain'), '');
    const env = { PATH: path.join(dir, 'bin') };
    assert.deepEqual(resolveCommand('tool', { env, platform: 'linux' }), { file: tool, prefixArgs: [], via: 'direct', path: tool });
    assert.equal(resolveCommand('plain', { env, platform: 'linux' }), null, 'POSIX needs the executable bit');
  } finally {
    cleanup();
  }
});

test('Windows ends a process tree with taskkill; POSIX signals the process group', () => {
  const calls = [];
  const spawnSync = (file, args, options) => {
    calls.push({ file, args, options });
    return { status: 0 };
  };
  assert.equal(killTree(4242, { platform: 'win32', spawnSync }), true);
  assert.deepEqual(calls, [{ file: 'taskkill', args: ['/pid', '4242', '/T', '/F'], options: { windowsHide: true, stdio: 'ignore' } }]);
  assert.equal(killTree(4242, { platform: 'win32', spawnSync: () => ({ status: 128 }) }), false, 'a tree already gone reports false');
  assert.equal(killTree(2 ** 30, { platform: 'linux' }), false, 'no such process group');
  assert.equal(killTree(undefined), false);
});

test('spawn options, check shells and Windows variable names', () => {
  assert.deepEqual(childSpawnOptions('linux'), { detached: true });
  assert.deepEqual(childSpawnOptions('win32'), { detached: false, windowsHide: true });
  assert.deepEqual(workerSpawnOptions('win32'), { detached: true, windowsHide: true });
  assert.equal(checkShell(undefined), true);
  assert.equal(checkShell('C:\\Program Files\\Git\\bin\\bash.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(envValue({ Path: 'a' }, 'PATH', 'win32'), 'a');
  assert.equal(envValue({ Path: 'a' }, 'PATH', 'linux'), undefined);
});

test('a rename that Windows refuses for a moment is retried', () => {
  let tries = 0;
  const fsImpl = {
    renameSync() {
      tries += 1;
      if (tries < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    },
  };
  assert.equal(renameWithRetry('a', 'b', { fsImpl, delayMs: 1 }), 3);
  const broken = { renameSync: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
  assert.throws(() => renameWithRetry('a', 'b', { fsImpl: broken, delayMs: 1 }), err => err.code === 'ENOENT');
  const stuck = { renameSync: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } };
  assert.throws(() => renameWithRetry('a', 'b', { fsImpl: stuck, attempts: 3, delayMs: 1 }), err => err.code === 'EBUSY');
});

// DSH Desktop's dsh.cmd, as found on the user's Windows machine in the real run.
const DSH_DESKTOP_SHIM = (exe, script) => `@echo off\r
setlocal DisableDelayedExpansion\r
for /f "tokens=2 delims=:" %%c in ('chcp 2^>nul') do set "DSH_RUNTIME_CODEPAGE=%%c"\r
chcp 65001>nul 2>nul\r
set "ELECTRON_RUN_AS_NODE=1"\r
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\\.dsh"\r
set "DSH_DESKTOP_DEFAULT_PROFILE=desktop"\r
"${exe}" --expose-internals "${script}" %*\r
set "DSH_RUNTIME_EXIT=%errorlevel%"\r
chcp %DSH_RUNTIME_CODEPAGE% >nul 2>nul\r
exit /b %DSH_RUNTIME_EXIT%\r
`;

test('a launcher shim that sets variables and starts an .exe runs that .exe with them', () => {
  const { dir, cleanup } = tempDir('agenthub-dsh-');
  try {
    const exe = path.join(dir, 'DSH Desktop', 'DSH Desktop.exe');
    const script = path.join(dir, 'DSH Desktop', 'resources', 'app', 'lib', 'desktop-cli.js');
    write(exe);
    write(script);
    const bin = path.join(dir, 'bin');
    write(path.join(bin, 'dsh.cmd'), DSH_DESKTOP_SHIM(exe, script));
    const env = { Path: bin, PATHEXT: '.EXE;.CMD', USERPROFILE: 'C:\\Users\\me' };
    const resolved = resolveCommand('dsh', { env, platform: 'win32' });
    assert.equal(resolved.via, 'shim-exe');
    assert.equal(resolved.file, exe);
    assert.deepEqual(resolved.prefixArgs, ['--expose-internals', script]);
    assert.deepEqual(resolved.env, { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: 'C:\\Users\\me\\.dsh', DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' });

    const launch = spawnArgv(['dsh', '--profile', 'headless', 'line one\nline two'], { env: { ...env, DSH_HOME: 'D:\\dsh' }, platform: 'win32' });
    assert.deepEqual(launch.argv, [exe, '--expose-internals', script, '--profile', 'headless', 'line one\nline two'], 'the task stays one argument');
    assert.equal(launch.env.DSH_HOME, undefined, 'a DSH_HOME the user already set is kept');
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
    assert.deepEqual(spawnArgv(['nowhere'], { env, platform: 'win32' }), { argv: ['nowhere'], env: {} });
  } finally {
    cleanup();
  }
});

test('launcher shims of other shapes are not guessed at', () => {
  assert.equal(launcherShim('@echo off\r\ncall other.bat %*\r\n'), null);
  assert.equal(launcherShim('"relative\\tool.exe" %*'), null);
  assert.equal(launcherShim('"C:\\x\\tool.exe" %UNKNOWN% %*'), null, 'arguments with variables are not expanded blindly');
});
