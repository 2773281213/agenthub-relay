// Unit tests of the 0.5 pieces, through their public functions: the state
// machine with turns and reservations, scope holding and follow-up policy,
// each adapter's resume / session / takeover interface, and the opener.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { adapterFor, buildFollowUpPrompt, displayCommand, dshCapabilities, normalizeUsage } from '../src/executors.mjs';
import { openDetached } from '../src/platform.mjs';
import { holdsScope, planSend, PolicyError } from '../src/policy.mjs';
import { checkTransition, createStore, isAbandonedReservation, turnNumber, turnsOf } from '../src/store.mjs';
import { tempDir } from './helpers.mjs';

const config = loadConfig({ env: {} });
const files = { final: '/tmp/job/final.md' };

function job(extra = {}) {
  return {
    id: 'j20261029-000000-abcdef',
    tier: 'deep',
    write: true,
    executor: 'codex',
    title: 'Refactor the parser',
    task: 'Split parse() into tokenize() and build().',
    scope: ['src/parser'],
    checks: ['npm test'],
    base: { commit: '0123456789abcdef0123456789abcdef01234567' },
    worktree: '.agenthub/worktrees/j20261029-000000-abcdef',
    branch: 'agenthub/j20261029-000000-abcdef',
    integration: 'none',
    ...extra,
  };
}

function refused(fn, code) {
  assert.throws(fn, err => err instanceof PolicyError && err.code === code, `expected ${code}`);
}

test('a finished job takes another turn through queued; apply and discard may reserve it first', () => {
  const done = job({ status: 'completed' });
  assert.doesNotThrow(() => checkTransition(done, { ...done, status: 'queued' }));
  const applied = { ...done, integration: 'applied' };
  assert.throws(() => checkTransition(applied, { ...applied, status: 'queued' }), err => err.code === 'invalid-transition');
  const queued = { ...done, status: 'queued' };
  assert.throws(() => checkTransition(queued, { ...queued, status: 'verifying' }), err => err.code === 'invalid-transition', 'only a collect turn skips the executor');
  assert.doesNotThrow(() => checkTransition(queued, { ...queued, status: 'verifying', turns: [{ n: 1 }, { n: 2, kind: 'collect' }] }));
  assert.doesNotThrow(() => checkTransition(done, { ...done, integration: 'applying' }));
  const applying = { ...done, integration: 'applying' };
  assert.doesNotThrow(() => checkTransition(applying, { ...applying, integration: 'applied' }));
  assert.doesNotThrow(() => checkTransition(applying, { ...applying, integration: 'none' }));
  assert.throws(() => checkTransition(applying, { ...applying, integration: 'discarded' }), err => err.code === 'invalid-transition');
  assert.throws(() => checkTransition(applying, { ...applying, status: 'queued' }), err => err.code === 'invalid-transition', 'no turn while an apply works');

  assert.equal(isAbandonedReservation({ integration: 'applying', integrationPid: process.pid, integrationAt: new Date().toISOString() }), false);
  assert.equal(isAbandonedReservation({ integration: 'applying', integrationPid: 2_147_483_000, integrationAt: new Date().toISOString() }), true);
  assert.equal(isAbandonedReservation({ integration: 'discarding', integrationPid: process.pid, integrationAt: new Date(Date.now() - 11 * 60_000).toISOString() }), true, 'too old, whatever the pid');
  assert.equal(isAbandonedReservation({ integration: 'none' }), false);
});

test('a lost worker ends its turn too; records from before turns read as one dispatch turn', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = createStore(dir);
    const created = store.create(job({ id: 'j20261121-000000-aaaaaa', worktree: 'w', branch: 'b', turns: [{ n: 1, kind: 'dispatch', status: 'queued' }] }));
    await store.update(created.id, draft => {
      draft.status = 'running';
      draft.worker = { pid: 2_147_483_000 };
      draft.heartbeatAt = new Date(Date.now() - 10 * 60_000).toISOString();
      draft.turns[0].status = 'running';
    });
    const lost = await store.reconcile(store.read(created.id));
    assert.equal(lost.status, 'failed');
    assert.deepEqual([lost.turns[0].status, lost.turns[0].error], ['failed', 'worker-lost']);
    assert.ok(lost.turns[0].endedAt);
    assert.deepEqual(turnsOf({ status: 'completed', startedAt: 'a', endedAt: 'b' }), [{ n: 1, kind: 'dispatch', by: 'planner', status: 'completed', startedAt: 'a', endedAt: 'b' }]);
    assert.equal(turnNumber({ turns: [{ n: 1 }, { n: 2 }] }), 2);
    assert.match(store.paths(created.id).turn(3).executorLog, /turns[\\/]3[\\/]executor\.log$/);
  } finally {
    cleanup();
  }
});

test('a job keeps its scope while taken over or while an apply or discard is working on it', () => {
  const claim = extra => holdsScope(job({ ...extra }));
  assert.equal(claim({ status: 'running' }), true);
  assert.equal(claim({ status: 'completed' }), true);
  assert.equal(claim({ status: 'failed' }), false, 'a failed job lets go of its scope');
  assert.equal(claim({ status: 'failed', takeover: { at: 'now' } }), true, '...unless a person took it over');
  assert.equal(claim({ status: 'completed', integration: 'applying' }), true);
  assert.equal(claim({ status: 'failed', integration: 'discarding' }), true);
  assert.equal(claim({ status: 'completed', integration: 'applied' }), false);
  assert.equal(claim({ status: 'running', write: false }), false, 'a review claims nothing');
});

test('a follow-up needs a session to continue, an unintegrated job not taken over, and its scope back when it had let go', () => {
  const done = extra => job({ status: 'completed', native: { sessionId: 't-1' }, ...extra });
  const base = { jobs: [], config, session: undefined };
  assert.deepEqual(planSend({ ...base, job: done(), request: { message: ' fix it ' } }), { message: 'fix it' });
  refused(() => planSend({ ...base, job: done(), request: { message: 'x' }, role: 'executor' }), 'executor-role');
  refused(() => planSend({ ...base, job: done(), request: { message: '  ' } }), 'invalid-request');
  refused(() => planSend({ ...base, job: done({ native: {} }), request: { message: 'x' } }), 'resume-unsupported');
  refused(() => planSend({ ...base, job: done({ integration: 'applied' }), request: { message: 'x' } }), 'already-integrated');
  refused(() => planSend({ ...base, job: done({ integration: 'applying' }), request: { message: 'x' } }), 'job-busy');
  refused(() => planSend({ ...base, job: done({ takeover: { at: 'then' } }), request: { message: 'x' } }), 'taken-over');
  assert.ok(planSend({ ...base, job: done({ takeover: { at: 'then' } }), request: { message: 'x', force: true } }));
  const other = job({ id: 'j20261121-000001-bbbbbb', scope: ['src/parser/lex'], status: 'running' });
  refused(() => planSend({ ...base, jobs: [other], job: done({ status: 'failed' }), request: { message: 'x' } }), 'scope-conflict');
  assert.ok(planSend({ ...base, jobs: [other], job: done(), request: { message: 'x' } }), 'a completed job never let go of its scope');
  refused(() => planSend({ ...base, session: null, job: done(), request: { message: 'x' } }), 'session-required');
});

test('each executor continues its own session: codex exec resume, claude --resume, dsh --session-id, agy --conversation', () => {
  const codex = adapterFor('codex').resume(job(), config.executors.codex, files, 'P', 't-9');
  assert.deepEqual(codex.argv, ['codex', 'exec', 'resume', '--json', '-o', files.final, '-c', 'sandbox_mode="workspace-write"', 't-9', '-']);
  assert.equal(codex.stdin, 'P');
  const review = adapterFor('codex').resume(job({ write: false, model: 'gpt-5.1-codex' }), config.executors.codex, files, 'P', 't-9');
  assert.deepEqual(review.argv.slice(6), ['-c', 'sandbox_mode="read-only"', '-m', 'gpt-5.1-codex', 't-9', '-']);

  const first = adapterFor('claude').invocation(job({ native: { sessionId: 'uuid-1' } }), config.executors.claude, files, 'P');
  assert.deepEqual(first.argv.slice(0, 6), ['claude', '-p', '--output-format', 'json', '--session-id', 'uuid-1']);
  const claude = adapterFor('claude').resume(job(), config.executors.claude, files, 'P', 'uuid-1');
  assert.deepEqual(claude.argv.slice(0, 6), ['claude', '-p', '--resume', 'uuid-1', '--output-format', 'json']);
  assert.deepEqual(claude.argv.slice(-2), ['--allowedTools', 'Bash(npm test)'], 'the variadic flag stays last');

  const caps = { json: true, sessions: true };
  assert.deepEqual(adapterFor('dsh').invocation(job(), config.executors.dsh, files, 'P', caps), { argv: ['dsh', '--profile', 'headless', '--json', '-'], stdin: 'P' });
  assert.deepEqual(adapterFor('dsh').resume(job(), config.executors.dsh, files, 'P', 's-1', caps).argv, ['dsh', '--profile', 'headless', '--json', '--session-id', 's-1', '-']);
  assert.throws(() => adapterFor('dsh').resume(job(), config.executors.dsh, files, 'P', 's-1', {}), err => err.code === 'resume-unsupported');
  assert.deepEqual(
    adapterFor('agy').resume(job({ checks: [] }), config.executors.agy, files, 'P', 'c-1').argv,
    ['agy', '--input-format', 'stream-json', '--output-format', 'stream-json', '--conversation', 'c-1', '--mode', 'accept-edits'],
  );

  const prompt = buildFollowUpPrompt(job(), { n: 2, message: 'Also handle empty input.' });
  assert.match(prompt, /follow-up for job j20261029-000000-abcdef \(deep tier\), turn 2/);
  assert.match(prompt, /Also handle empty input\./);
  assert.match(prompt, /scope: src\/parser/);
  assert.match(prompt, /checks again: `npm test`/);
});

test('session ids come from the first lines that carry them; dsh --json reports its final turn; usage reads the same for every executor', () => {
  assert.equal(adapterFor('codex').sessionFromLine('{"type":"thread.started","thread_id":"t-1"}'), 't-1');
  assert.equal(adapterFor('codex').sessionFromLine('{"type":"turn.started"}'), undefined);
  assert.equal(adapterFor('agy').sessionFromLine('{"event":"init","conversation_id":"c-1"}'), 'c-1');
  assert.equal(adapterFor('dsh').sessionFromLine('{"type":"session","sessionId":"s-1","cwd":"/w"}'), 's-1');
  assert.equal(adapterFor('claude').sessionFromLine('anything'), undefined, 'Claude Code takes its id up front');

  const dsh = adapterFor('dsh');
  const stream = final => [JSON.stringify({ type: 'session', sessionId: 's-1' }), JSON.stringify({ type: 'text', text: 'partial' }), ...(final ? [JSON.stringify(final)] : [])].join('\n');
  assert.deepEqual(dsh.parse({ exitCode: 0, stdout: stream({ type: 'final', sessionId: 's-1', reason: { kind: 'completed' }, text: 'Done.\n' }), stderr: '', caps: { json: true } }),
    { ok: true, summary: 'Done.', sessionId: 's-1', error: undefined });
  const aborted = dsh.parse({ exitCode: 1, stdout: stream({ type: 'final', sessionId: 's-1', reason: { kind: 'aborted' }, text: '' }), stderr: '', caps: { json: true } });
  assert.equal(aborted.ok, false);
  assert.match(aborted.error, /aborted/);
  assert.equal(dsh.parse({ exitCode: 0, stdout: stream(null), stderr: '', caps: { json: true } }).ok, false, 'no final event, no success');
  assert.match(dsh.parse({ exitCode: 1, stdout: JSON.stringify({ type: 'error', message: 'no API key' }), stderr: '', caps: { json: true } }).error, /no API key/);

  assert.deepEqual(normalizeUsage('codex', { usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7 } }), { inputTokens: 100, cachedInputTokens: 80, outputTokens: 7 });
  assert.deepEqual(
    normalizeUsage('claude', { usage: { input_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 3 }, costUsd: 0.01 }),
    { inputTokens: 100, cachedInputTokens: 90, outputTokens: 3, costUsd: 0.01 },
  );
  assert.deepEqual(normalizeUsage('dsh', {}), {});
  assert.deepEqual(dshCapabilities('definitely-not-a-dsh-xyz', { env: { PATH: '' } }), { json: false, sessions: false });
});

test('a takeover opens Claude Code in the desktop app, Codex by its codex:// link, and the others in a terminal', () => {
  const claude = adapterFor('claude').takeover({ command: 'claude', sessionId: 'u-1' });
  assert.deepEqual(claude.app.argv, ['claude', '--desktop', '--resume', 'u-1']);
  assert.deepEqual(claude.terminal.argv, ['claude', '--resume', 'u-1']);
  const codex = adapterFor('codex').takeover({ command: 'codex', sessionId: 't-1' });
  assert.equal(codex.app.url, 'codex://threads/t-1');
  assert.equal(codex.app.verified, false);
  assert.deepEqual(codex.terminal.argv, ['codex', 'resume', 't-1']);
  const agy = adapterFor('agy').takeover({ command: 'agy', sessionId: 'c-1' });
  assert.equal(agy.app, undefined);
  assert.deepEqual(agy.terminal.argv, ['agy', '--conversation', 'c-1']);
  assert.match(adapterFor('dsh').takeover({ command: 'dsh', sessionId: 's-1' }).note, /dsh web/);
  assert.equal(displayCommand(['C:\\Program Files\\x\\codex.exe', 'resume', 't-1'], 'win32'), '& "C:\\Program Files\\x\\codex.exe" resume t-1');
  assert.equal(displayCommand(['/usr/bin/claude', '--resume', 'a b'], 'linux'), "/usr/bin/claude --resume 'a b'");
});

test("a chained DSH launcher is followed: call, %~dp0 and the if-exist choice of its entry script", { skip: process.platform !== 'win32' && 'cmd.exe paths' }, async () => {
  const { resolveCommand } = await import('../src/platform.mjs');
  const { dir, cleanup } = tempDir('agenthub-dsh-chain-');
  try {
    const app = path.join(dir, 'DeepSeek Harness');
    const exe = path.join(app, 'DeepSeek Harness.exe');
    const entry = path.join(app, 'resources', 'app', 'dsh', 'lib', 'cli.js');
    for (const file of [exe, entry]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
    const inner = path.join(app, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    fs.mkdirSync(path.dirname(inner), { recursive: true });
    fs.writeFileSync(inner, [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'set "ELECTRON_RUN_AS_NODE=1"',
      'REM dsh-purge cli entry begin',
      'set "entry=%~dp0..\\..\\..\\app.asar\\dsh\\lib\\cli.js"',
      'if not exist "%~dp0..\\..\\..\\app.asar" (',
      '  set "entry=%~dp0..\\..\\..\\app\\dsh\\lib\\cli.js"',
      '  if exist "%~dp0..\\..\\..\\app.asar.unpacked\\dsh\\lib\\cli.js" set "entry=%~dp0..\\..\\..\\app.asar.unpacked\\dsh\\lib\\cli.js"',
      ')',
      'REM dsh-purge cli entry end',
      '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%entry%" %*',
      'exit /b %errorlevel%',
    ].join('\r\n'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'dsh.cmd'), ['@echo off', 'setlocal DisableDelayedExpansion', 'if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\\.dsh"', `call "${inner}" %*`, 'exit /b %errorlevel%'].join('\r\n'));
    const resolved = resolveCommand('dsh', { env: { Path: bin, PATHEXT: '.EXE;.CMD', USERPROFILE: 'C:\\Users\\me' }, platform: 'win32' });
    assert.equal(resolved.via, 'shim-exe');
    assert.equal(resolved.file, exe);
    assert.deepEqual(resolved.prefixArgs, ['--expose-internals', entry]);
    assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(resolved.env.DSH_HOME, 'C:\\Users\\me\\.dsh');
  } finally {
    cleanup();
  }
});

test('a takeover opens only codex:// thread links and relay-built commands, without a shell and without the planner session variables', async () => {
  const spawned = [];
  const spawn = (file, args, options) => {
    spawned.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  const env = { PATH: '', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'planner', AGENTHUB_RELAY_ROLE: 'x', CODEX_THREAD_ID: 'p', KEEP: 'yes' };
  assert.deepEqual(await openDetached({ url: 'codex://threads/019a-b2' }, { env, platform: 'win32', spawn }), { ok: true, pid: 4242 });
  assert.equal(spawned[0].file, 'rundll32.exe');
  assert.deepEqual(spawned[0].args, ['url.dll,FileProtocolHandler', 'codex://threads/019a-b2']);
  assert.equal(spawned[0].options.shell, undefined);
  assert.deepEqual(Object.keys(spawned[0].options.env).sort(), ['KEEP', 'PATH'], 'Claude Code refuses to start inside what looks like another session');
  await openDetached({ url: 'codex://threads/x' }, { env, platform: 'darwin', spawn });
  assert.equal(spawned[1].file, 'open');
  for (const bad of ['codex://threads/a b', 'codex://threads/x&calc', 'https://example.com', 'codex://threads/']) {
    assert.equal((await openDetached({ url: bad }, { env, platform: 'win32', spawn })).ok, false, bad);
  }
  assert.equal(spawned.length, 2, 'refused links start nothing');
  const { dir, cleanup } = tempDir();
  try {
    const script = path.join(dir, 'claude.mjs');
    fs.writeFileSync(script, '');
    await openDetached({ argv: [script, '--desktop', '--resume', 's-1'], cwd: dir }, { env, spawn });
    assert.deepEqual(spawned[2].args, [script, '--desktop', '--resume', 's-1']);
    assert.equal(spawned[2].file, process.execPath, 'a script runs with this Node.js');
    assert.equal(spawned[2].options.cwd, dir);
    assert.equal((await openDetached({ argv: [path.join(dir, 'missing-tool')] }, { env, spawn })).ok, false);
  } finally {
    cleanup();
  }
});
