// The codexhost executor: jobs run as Threads of a codex-host Host through
// its CLI. Real worker processes drive a fake codexhost CLI
// (fixtures/fake-codexhost.mjs) whose Host state lives in CODEXHOST_DATA_DIR.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { readSnapshot, questionsOf, envFor } from '../src/codexhost.mjs';
import { buildConfig, parseRoute } from '../src/config.mjs';
import { isExecutorCaller, planDispatch } from '../src/policy.mjs';
import { routeText, plainRoute } from '../src/session.mjs';
import { isAlive } from '../src/store.mjs';
import { createRelay } from '../src/tools.mjs';
import { fakeTask, makeRepo, ROOT, tempDir, useFakeExecutors, waitFor } from './helpers.mjs';

const FAKE_HOST = path.join(ROOT, 'test', 'fixtures', 'fake-codexhost.mjs');
const CHECK = "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every(file => fs.existsSync(file)) ? 0 : 1);\n";
const FILES = { 'README.md': '# demo\n', 'src/app.txt': 'app\n', 'check.mjs': CHECK };

function setup(extraEnv = {}) {
  const repo = makeRepo(FILES);
  const data = tempDir('agenthub-codexhost-');
  fs.chmodSync(FAKE_HOST, 0o755);
  useFakeExecutors(repo.dir, { top: { executors: { codexhost: { command: FAKE_HOST, timeoutMinutes: 2 } }, sessions: { required: false } } });
  const env = {
    ...process.env,
    AGENTHUB_RELAY_ROOT: repo.dir,
    CODEXHOST_DATA_DIR: data.dir,
    // what a codexhost session leaves behind: never passed to the CLI
    CODEXHOST_RUNTIME_ENDPOINT: 'http://127.0.0.1:1/stale',
    AGENTHUB_RELAY_WAKE_TICK_MS: '200',
  };
  for (const name of ['CLAUDE_PROJECT_DIR', 'AGENTHUB_RELAY_ROLE', 'CODEXHOST_THREAD_ID', 'CODEX_THREAD_ID']) delete env[name];
  Object.assign(env, extraEnv);
  const relay = createRelay({ cwd: repo.dir, env, clientName: () => 'test-planner' });
  // The fake rewrites its state file on every call: a read may catch it half written.
  const host = () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return JSON.parse(fs.readFileSync(path.join(data.dir, 'fake-host.json'), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return { threads: {}, calls: [] }; // no call yet
        if (attempt >= 20) throw err;
      }
    }
  };
  return {
    dir: repo.dir,
    dataDir: data.dir,
    env,
    relay,
    host,
    cleanup() {
      // A waker started by a test ends within a tick or two once nothing is left to tell.
      const wakeDir = path.join(repo.dir, '.agenthub', 'wake');
      const deadline = Date.now() + 10_000;
      const running = () => fs.existsSync(wakeDir) && fs.readdirSync(wakeDir).filter(name => name.endsWith('.json')).some(name => {
        try {
          const { pid } = JSON.parse(fs.readFileSync(path.join(wakeDir, name), 'utf8'));
          return Number.isInteger(pid) && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
        } catch {
          return false;
        }
      });
      while (running() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      repo.cleanup();
      data.cleanup();
    },
  };
}

async function settle(relay, jobId) {
  return waitFor(async () => {
    const { job } = await relay.call('relay_status', { jobId });
    return ['completed', 'failed', 'cancelled'].includes(job.status) ? job : undefined;
  }, { timeoutMs: 40_000, what: `job ${jobId}` });
}

/** Make a dead worker's heartbeat old enough that reconciliation would call it lost. */
function expireHeartbeat(root, jobId) {
  const file = path.join(root, '.agenthub', 'jobs', jobId, 'job.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.heartbeatAt = new Date(Date.now() - 10 * 60_000).toISOString();
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

describe('the codexhost executor', () => {
  test('a job runs as a Thread on its harness in the job worktree; a send continues the Thread and the patch covers both turns', async () => {
    const t = setup();
    try {
      const { jobId, harness } = await t.relay.call('relay_dispatch', {
        tier: 'deep',
        executor: 'codexhost/fakeh',
        scope: ['src'],
        checks: ['node check.mjs src/a.txt'],
        task: fakeTask({ write: { 'src/a.txt': 'a\n' }, message: 'wrote a' }),
      });
      assert.equal(harness, 'fakeh');
      const first = await settle(t.relay, jobId);
      assert.equal(first.status, 'completed', JSON.stringify(first));
      const result = await t.relay.call('relay_result', { jobId });
      assert.equal(result.summary, 'wrote a');
      assert.equal(result.harness, 'fakeh');
      const [threadId] = Object.keys(t.host().threads);
      assert.equal(result.native.sessionId, threadId);
      const thread = t.host().threads[threadId];
      assert.equal(path.resolve(thread.cwd), path.resolve(t.dir, result.worktree));

      const start = t.host().calls.find(call => call.args[0] === 'delegate');
      assert.deepEqual(start.args.slice(0, 4), ['delegate', 'start', '--harness', 'fakeh']);
      assert.ok(start.env.includes('CODEXHOST_DATA_DIR'), 'the CLI is told where the Host is');
      assert.ok(!start.env.includes('CODEXHOST_RUNTIME_ENDPOINT'), 'a stale Runtime endpoint is not passed on');

      const takeover = await t.relay.call('relay_takeover', { jobId });
      assert.equal(takeover.app.url, `codex://threads/${threadId}`);
      await t.relay.call('relay_collect', { jobId });
      await settle(t.relay, jobId);

      await t.relay.call('relay_send', { jobId, message: fakeTask({ write: { 'src/b.txt': 'b\n' }, message: 'wrote b' }) });
      const second = await settle(t.relay, jobId);
      assert.equal(second.status, 'completed');
      const again = await t.relay.call('relay_result', { jobId });
      assert.deepEqual([...again.changedFiles].sort(), ['src/a.txt', 'src/b.txt']);
      const send = t.host().calls.find(call => call.args[1] === 'send');
      assert.deepEqual(send.args.slice(0, 3), ['thread', 'send', threadId]);
      assert.ok(!send.args.includes('--interrupt'), 'an idle Thread gets a plain send');
      assert.equal(Object.keys(t.host().threads).length, 1, 'the same Thread, not a new one');
    } finally {
      t.cleanup();
    }
  });

  test('a question ends the turn as needs-input: the job keeps its scope, its Thread may not plan, and an answer interrupts the waiting turn', async () => {
    const t = setup();
    try {
      const { jobId } = await t.relay.call('relay_dispatch', {
        tier: 'deep',
        executor: 'codexhost',
        harness: 'fakeh',
        scope: ['src'],
        task: fakeTask({ write: { 'src/a.txt': 'a\n' }, ask: 'Overwrite the old file?' }),
      });
      const waiting = await settle(t.relay, jobId);
      assert.equal(waiting.status, 'failed');
      assert.equal(waiting.error, 'needs-input');
      assert.equal(waiting.needsInput, true);
      const result = await t.relay.call('relay_result', { jobId });
      assert.equal(result.needsInput.questions[0].text, 'Overwrite the old file?');
      assert.deepEqual(result.needsInput.questions[0].options, ['yes', 'no']);
      assert.equal(result.next[1].tool, 'relay_send');

      await assert.rejects(
        t.relay.call('relay_dispatch', { tier: 'deep', executor: 'codexhost/fakeh', scope: ['src/x'], task: fakeTask({}) }),
        err => err.code === 'scope-conflict',
        'a job waiting for an answer still holds its scope',
      );

      // A sibling job the planner has not read yet.
      const { jobId: sibling } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ message: 'looked' }) });
      await settle(t.relay, sibling);

      // What a harness the Host started sees: the job's worktree as its
      // folder and its own Thread id, and none of the relay's variables.
      const threadId = result.native.sessionId;
      const worktree = path.join(t.dir, result.worktree);
      for (const name of ['CODEXHOST_THREAD_ID', 'CODEX_THREAD_ID']) {
        const env = { ...t.env, [name]: threadId };
        delete env.AGENTHUB_RELAY_ROOT;
        const inside = createRelay({ cwd: worktree, env, clientName: () => 'harness' });
        const agents = await inside.call('relay_agents', {});
        assert.equal(fs.realpathSync(agents.root), fs.realpathSync(t.dir), 'the main repository, not the worktree');
        assert.equal(agents.role, 'executor');
        for (const [tool, args] of [
          ['relay_dispatch', { tier: 'deep', executor: 'codexhost/fakeh', scope: ['docs'], task: fakeTask({}) }],
          ['relay_apply', { jobId: sibling, force: true }],
          ['relay_discard', { jobId: sibling }],
          ['relay_cancel', { jobId }],
          ['relay_send', { jobId: sibling, message: 'more' }],
          ['relay_takeover', { jobId: sibling }],
          ['relay_collect', { jobId: sibling }],
        ]) {
          await assert.rejects(inside.call(tool, args), err => err.code === 'executor-role', `${name} of a waiting job's Thread: ${tool}`);
        }
        await inside.call('relay_result', { jobId: sibling });
      }
      assert.equal((await t.relay.call('relay_status', { jobId: sibling })).job.resultFetched, false, "an executor's read is not the planner's");

      await t.relay.call('relay_send', { jobId, message: fakeTask({ message: 'overwrote it' }, 'yes') });
      const done = await settle(t.relay, jobId);
      assert.equal(done.status, 'completed');
      assert.equal(done.needsInput, undefined);
      const answer = t.host().calls.find(call => call.args[1] === 'send');
      assert.ok(answer.args.includes('--interrupt'), 'the answer replaces the turn that asked');

      const later = createRelay({ cwd: t.dir, env: { ...t.env, CODEXHOST_THREAD_ID: threadId }, clientName: () => 'planner' });
      const { jobId: next } = await later.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ message: 'ok' }) });
      assert.ok(next, 'once the job is done its Thread is an ordinary caller again');
      await settle(t.relay, next);
    } finally {
      t.cleanup();
    }
  });

  test('an asynchronous question lets the turn go on: the job completes and says what was left open, and a later turn is not held by it', async () => {
    const t = setup();
    try {
      const { jobId } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ askAsync: 'Which style?', delayMs: 1_500, message: 'looked' }) });
      const done = await settle(t.relay, jobId);
      assert.equal(done.status, 'completed', JSON.stringify(done));
      const result = await t.relay.call('relay_result', { jobId });
      assert.match(result.warnings.join('\n'), /left a question open in codexhost Thread .*"Which style\?" \(a \/ b\)/);
      await t.relay.call('relay_send', { jobId, message: fakeTask({ message: 'again' }) });
      const again = await settle(t.relay, jobId);
      assert.equal(again.status, 'completed', "the first turn's question does not stop the second");
      assert.equal((await t.relay.call('relay_result', { jobId })).summary, 'again');
    } finally {
      t.cleanup();
    }
  });

  test('cancelling a codexhost job whose worker died cancels its turn in the Host', async () => {
    const t = setup();
    try {
      const { jobId } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ delayMs: 60_000 }) });
      await waitFor(() => t.host().calls.some(call => call.args[1] === 'wait'), { what: 'the wait' });
      const record = JSON.parse(fs.readFileSync(path.join(t.dir, '.agenthub', 'jobs', jobId, 'job.json'), 'utf8'));
      // The worker dies (a crash, a reboot): with it its wait, not the Thread.
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(record.worker.pid)], { windowsHide: true });
      else process.kill(-record.worker.pid, 'SIGKILL');
      await waitFor(() => !isAlive(record.worker.pid), { what: 'the worker to end' });
      const cancelled = await t.relay.call('relay_cancel', { jobId });
      assert.equal(cancelled.status, 'cancelled');
      assert.ok(t.host().calls.some(call => call.args[1] === 'cancel' && call.args[2] === record.native.sessionId), 'thread cancel');
      assert.equal(t.host().threads[record.native.sessionId].turns.at(-1).interrupted, true);
    } finally {
      t.cleanup();
    }
  });

  test('cancelling a codexhost job whose worker died and heartbeat expired cancels the Host turn, not says job-finished', async () => {
    const t = setup();
    try {
      const { jobId } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ delayMs: 60_000 }) });
      await waitFor(() => t.host().calls.some(call => call.args[1] === 'wait'), { what: 'the wait' });
      const record = JSON.parse(fs.readFileSync(path.join(t.dir, '.agenthub', 'jobs', jobId, 'job.json'), 'utf8'));
      // The worker died long enough ago that readJob would normally reconcile
      // the job to failed/worker-lost before relay_cancel looks at it.
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(record.worker.pid)], { windowsHide: true });
      else process.kill(-record.worker.pid, 'SIGKILL');
      await waitFor(() => !isAlive(record.worker.pid), { what: 'the worker to end' });
      expireHeartbeat(t.dir, jobId);

      const cancelled = await t.relay.call('relay_cancel', { jobId });
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.cancelling, false);
      assert.ok(t.host().calls.some(call => call.args[1] === 'cancel' && call.args[2] === record.native.sessionId), 'thread cancel');
      assert.equal(t.host().threads[record.native.sessionId].turns.at(-1).interrupted, true);
    } finally {
      t.cleanup();
    }
  });

  test('discarding a codexhost job already reconciled as worker-lost cancels its Thread turn', async () => {
    const t = setup();
    try {
      const { jobId } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ delayMs: 60_000 }) });
      await waitFor(() => t.host().calls.some(call => call.args[1] === 'wait'), { what: 'the wait' });
      const record = JSON.parse(fs.readFileSync(path.join(t.dir, '.agenthub', 'jobs', jobId, 'job.json'), 'utf8'));
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(record.worker.pid)], { windowsHide: true });
      else process.kill(-record.worker.pid, 'SIGKILL');
      await waitFor(() => !isAlive(record.worker.pid), { what: 'the worker to end' });
      expireHeartbeat(t.dir, jobId);

      const { job } = await t.relay.call('relay_status', { jobId });
      assert.equal(job.status, 'failed');
      assert.equal(job.error, 'worker-lost');
      const discarded = await t.relay.call('relay_discard', { jobId });
      assert.equal(discarded.discarded, true);
      assert.ok(t.host().calls.some(call => call.args[1] === 'cancel' && call.args[2] === record.native.sessionId), 'thread cancel on discard');
      assert.equal(t.host().threads[record.native.sessionId].turns.at(-1).interrupted, true);
    } finally {
      t.cleanup();
    }
  });

  test('an empty codexhost harness list is cached for a minute, not fetched again by the next relay_agents', async () => {
    const t = setup();
    try {
      // The Host is down: harness list answers with no harnesses.
      fs.writeFileSync(path.join(t.dataDir, 'fake-host.json'), JSON.stringify({ threads: {}, calls: [], harnesses: [] }, null, 2));
      const first = await t.relay.call('relay_agents', {});
      assert.deepEqual(first.codexhost.harnesses, []);
      const second = await t.relay.call('relay_agents', {});
      assert.deepEqual(second.codexhost.harnesses, []);
      const lists = t.host().calls.filter(call => call.args[0] === 'harness' && call.args[1] === 'list');
      assert.equal(lists.length, 1, 'the negative result is kept for WAKE_RECHECK_MS');
    } finally {
      t.cleanup();
    }
  });

  test('a cancel cancels the Thread turn in the Host; a missing harness and a harness on another executor are refused', async () => {
    const t = setup();
    try {
      const { jobId } = await t.relay.call('relay_dispatch', {
        tier: 'review',
        executor: 'codexhost/fakeh',
        task: fakeTask({ delayMs: 60_000, message: 'late' }),
      });
      await waitFor(async () => (await t.relay.call('relay_status', { jobId })).job.status === 'running' && t.host().calls.some(call => call.args[1] === 'wait'), { what: 'the wait' });
      await t.relay.call('relay_cancel', { jobId });
      const job = await settle(t.relay, jobId);
      assert.equal(job.status, 'cancelled');
      await waitFor(() => t.host().calls.some(call => call.args[1] === 'cancel'), { what: 'thread cancel' });

      await assert.rejects(t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost', task: 'x' }), err => err.code === 'harness-required');
      await assert.rejects(t.relay.call('relay_dispatch', { tier: 'review', executor: 'codex', harness: 'pi', task: 'x' }), err => err.code === 'invalid-request');
      const { jobId: failed } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/missing', task: 'x' });
      const missing = await settle(t.relay, failed);
      assert.equal(missing.status, 'failed');
      const result = await t.relay.call('relay_result', { jobId: failed });
      assert.match(result.executorRun.error, /HARNESS_NOT_FOUND/);
    } finally {
      t.cleanup();
    }
  });
});

test('codexhost routes: codexhost/<harness> in routes and settings, executors.codexhost.harness as the default', () => {
  assert.deepEqual(parseRoute('codexhost/claude-code:ref-1@high'), { executor: 'codexhost', harness: 'claude-code', model: 'ref-1', effort: 'high' });
  assert.equal(routeText(plainRoute('codexhost/pi')), 'codexhost/pi');
  const config = buildConfig({ layers: [{ file: 'f', data: { profile: 'p', profiles: { p: { deep: 'codexhost/pi', light: 'dsh', review: 'claude' } }, executors: { codexhost: { harness: 'opencode' } } } }] });
  assert.equal(config.mapping.deep, 'codexhost');
  assert.equal(config.routes.deep.harness, 'pi');
  assert.equal(planDispatch({ request: { tier: 'deep', scope: ['.'], task: 't' }, config }).harness, 'pi');
  assert.equal(planDispatch({ request: { tier: 'deep', scope: ['.'], task: 't', executor: 'codexhost' }, config }).harness, 'pi');
  assert.equal(planDispatch({ request: { tier: 'review', task: 't', executor: 'codexhost' }, config }).harness, 'opencode');
  assert.throws(() => buildConfig({ layers: [{ file: 'f', data: { executors: { codex: { harness: 'pi' } } } }] }), /codexhost executor only/);
  assert.throws(() => buildConfig({ layers: [{ file: 'f', data: { profiles: { p: { deep: 'codex/pi' } } } }] }), /codexhost executor only/);
});

test('reading codexhost snapshots, and the environment its CLI gets', () => {
  assert.deepEqual(readSnapshot({ status: 'completed', turn: { turnId: 't2', status: 'completed' }, result: { text: 'ok' } }, 't2'), { state: 'completed', summary: 'ok' });
  assert.equal(readSnapshot({ status: 'completed', turn: { turnId: 't1', status: 'completed' } }, 't2').state, 'running', "an earlier turn's snapshot is not this turn's end");
  assert.deepEqual(readSnapshot({ status: 'interrupted', turn: { turnId: 't2', status: 'interrupted' } }, 't2'), { state: 'failed', status: 'interrupted', summary: '' });
  assert.equal(readSnapshot({ status: 'failed', turn: { turnId: 't2', status: 'failed' }, result: { availability: 'unavailable', message: 'bad key' } }, 't2').message, 'bad key');
  assert.equal(readSnapshot({ status: 'running', turn: { turnId: 't2', status: 'running' }, timedOut: true }, 't2').state, 'running');
  assert.equal(readSnapshot({ status: 'completed', turn: null, result: { availability: 'unavailable' } }, 't2').state, 'failed', 'a Thread done without the turn started is no success');
  assert.deepEqual(questionsOf({ pendingQuestions: ['Go?', { interactionId: 'i', prompt: 'Which?', choices: [{ label: 'A' }, 'B'] }] }), [{ text: 'Go?' }, { id: 'i', text: 'Which?', options: ['A', 'B'] }]);
  assert.deepEqual(
    questionsOf({
      pendingQuestions: [{
        interactionId: 'i2', kind: 'requestUserInput', turnId: 't2',
        request: { questions: [{ id: 'q1', question: 'First?' }, { id: 'q2', header: 'Second?' }] },
      }],
    }),
    [
      { id: 'i2', kind: 'requestUserInput', turnId: 't2', questionId: 'q1', text: 'First?' },
      { id: 'i2', kind: 'requestUserInput', turnId: 't2', questionId: 'q2', text: 'Second?' },
    ],
    'one interaction asking two questions is expanded with each question id',
  );

  const env = envFor({ PATH: 'p', AGENTHUB_RELAY_ROLE: 'executor' }, { CODEXHOST_DATA_DIR: 'd', CODEXHOST_CLIENT_TOKEN_FILE: 'f', CODEXHOST_RUNTIME_TOKEN: 'x', CODEXHOST_THREAD_ID: 't', SECRET: 's' });
  assert.deepEqual(env, { PATH: 'p', AGENTHUB_RELAY_ROLE: 'executor', CODEXHOST_DATA_DIR: 'd', CODEXHOST_CLIENT_TOKEN_FILE: 'f' });

  const job = { executor: 'codexhost', status: 'failed', error: { code: 'needs-input' }, native: { sessionId: 'th-1' }, integration: 'none' };
  assert.equal(isExecutorCaller({ CODEX_THREAD_ID: 'th-1' }, [job]), true);
  assert.equal(isExecutorCaller({ CODEX_THREAD_ID: 'th-1' }, [{ ...job, error: { code: 'executor-failed' } }]), false);
  assert.equal(isExecutorCaller({ CODEX_THREAD_ID: 'th-1' }, [{ ...job, executor: 'codex' }]), false, 'only a codexhost job\'s Thread');
  assert.equal(isExecutorCaller({}, [job]), false);
});

test('a discard whose worktree folder another process holds still discards, and says what it left', async () => {
  const t = setup();
  let holder;
  try {
    const { jobId } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ message: 'looked' }) });
    await settle(t.relay, jobId);
    const { worktree } = await t.relay.call('relay_result', { jobId });
    const { spawn } = await import('node:child_process');
    // what a harness left running in the folder it worked in
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: path.join(t.dir, worktree), stdio: 'ignore', windowsHide: true });
    await new Promise(resolve => holder.once('spawn', resolve));
    const discarded = await t.relay.call('relay_discard', { jobId });
    assert.equal(discarded.discarded, true);
    if (process.platform === 'win32') {
      assert.match(discarded.warnings[0], /could not be deleted/);
      const record = JSON.parse(fs.readFileSync(path.join(t.dir, '.agenthub', 'jobs', jobId, 'job.json'), 'utf8'));
      assert.ok(record.warnings.some(warning => /could not be deleted/.test(warning)), 'kept in the record for relay_result');
    }
    assert.equal((await t.relay.call('relay_status', { jobId })).job.integration, 'discarded');
  } finally {
    holder?.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
    t.cleanup();
  }
});

describe('waking a planner that runs in a codexhost Thread', () => {
  /**
   * A planner Thread in the fake Host. With `busy` its current turn runs until
   * releasePlanner() says it ended (a flag file of its own, so the test never
   * rewrites the state the fake Host keeps changing).
   */
  function seedPlanner(t, id, { busy = false } = {}) {
    const file = path.join(t.env.CODEXHOST_DATA_DIR, 'fake-host.json');
    // Under the fake Host's own lock, replaced whole: its calls may be running.
    const lockDir = path.join(t.env.CODEXHOST_DATA_DIR, 'fake-host.lock');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST' || attempt > 2_000) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { threads: {}, calls: [] };
      const turn = { turnId: 'p-1', input: 'plan', readyAt: 0, outcome: 'completed', text: '', questions: [], ...(busy ? { holdUntil: id } : {}) };
      state.threads[id] = { harness: 'planner', cwd: t.dir, title: 'planner', turns: [turn] };
      fs.writeFileSync(`${file}.seed`, JSON.stringify(state));
      fs.renameSync(`${file}.seed`, file);
    } finally {
      fs.rmdirSync(lockDir);
    }
  }

  function releasePlanner(t, id) {
    fs.writeFileSync(path.join(t.env.CODEXHOST_DATA_DIR, `release-${id}`), '');
  }

  test('the jobs that end are told to the planner Thread in one message once its busy turn ends', async () => {
    const planner = '11111111-2222-4333-8444-555555555555';
    const t = setup({ CODEXHOST_THREAD_ID: planner, AGENTHUB_RELAY_WAKE_TICK_MS: '200' });
    try {
      // The planner is in a turn until the test ends it, whatever the load.
      seedPlanner(t, planner, { busy: true });
      const a = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', title: 'look at a', task: fakeTask({ message: 'a' }) });
      const b = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', title: 'look at b', task: fakeTask({ message: 'b' }) });
      assert.equal(a.watcher.active, true, 'a planner the Host can reach is told it will be woken');
      assert.equal(a.watcher.via, 'codexhost');
      await settle(t.relay, a.jobId);
      await settle(t.relay, b.jobId);
      // The waker tries, and is refused, until the planner's turn ends. Once a
      // refused try named both jobs, no notice written before b ended is still
      // on its way: the next try, after the turn ends, merges them.
      await waitFor(
        () => t.host().calls.some(call => call.args[1] === 'send' && call.args[2] === planner && call.input?.includes(a.jobId) && call.input?.includes(b.jobId)),
        { what: 'a try that names both jobs' },
      );
      assert.equal(t.host().threads[planner].turns.length, 1, 'nothing sent into a busy turn');

      // The planner's turn ends: the next send gets through.
      releasePlanner(t, planner);
      const woken = await waitFor(() => {
        const turns = t.host().threads[planner].turns;
        return turns.length > 1 ? turns : undefined;
      }, { timeoutMs: 30_000, what: 'the wake' });
      assert.equal(woken.length, 2, 'both jobs in one message');
      const diagnose = () => {
        try {
          const wakeLog = path.join(t.dir, '.agenthub', 'wake', 'wake.log');
          const record = id => JSON.parse(fs.readFileSync(path.join(t.dir, '.agenthub', 'jobs', id, 'job.json'), 'utf8'));
          const brief = job => ({ status: job.status, endedAt: job.endedAt, updatedAt: job.updatedAt, wake: job.wake, resultFetchedTurn: job.resultFetchedTurn, turns: job.turns?.length });
          return JSON.stringify({ log: fs.existsSync(wakeLog) ? fs.readFileSync(wakeLog, 'utf8') : null, a: brief(record(a.jobId)), b: brief(record(b.jobId)), sends: t.host().calls.filter(call => call.args[1] === 'send').length }, null, 1);
        } catch (err) {
          return JSON.stringify({ error: err.code ?? err.message });
        }
      };
      // Build the diagnosis only on mismatch: a passing assertion must not read
      // job.json while the waker may be replacing it.
      if (!/2 jobs you dispatched have ended/.test(woken[1].input)) {
        assert.fail(`the wake did not name both jobs: ${woken[1].input}\n${diagnose()}`);
      }
      assert.ok(woken[1].input.includes(a.jobId) && woken[1].input.includes(b.jobId));
      // Recorded by the waker right after its send went through.
      await waitFor(async () => (await t.relay.call('relay_status', { jobId: a.jobId })).job.wake.notifiedTurn === 1, { what: 'the notice on record' });

      const agents = await t.relay.call('relay_agents', {});
      assert.equal(agents.wake.via, 'codexhost');
      assert.equal(agents.planners.codex.keepAlive, 'unsupported');
    } finally {
      t.cleanup();
    }
  });

  test('a Thread the Host does not know is not promised a wake, and is asked again once the Host may know it', async () => {
    const planner = '99999999-2222-4333-8444-555555555555';
    const t = setup({ CODEX_THREAD_ID: planner, AGENTHUB_RELAY_WAKE_RECHECK_MS: '300' });
    try {
      const { watcher, jobId } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ message: 'a' }) });
      assert.equal(watcher.active, false);
      assert.equal((await t.relay.call('relay_agents', {})).wake.via, 'relay_wait');
      await settle(t.relay, jobId);
      assert.equal((await t.relay.call('relay_status', { jobId })).job.wake, undefined);

      // The Host was restarting, say: the Thread is there now.
      seedPlanner(t, planner);
      await new Promise(resolve => setTimeout(resolve, 400));
      const again = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ message: 'b' }) });
      assert.equal(again.watcher.active, true);
      await settle(t.relay, again.jobId);
    } finally {
      t.cleanup();
    }
  });
});

test('which ended jobs a planner Thread is still to be told about, and one waker per Thread', async () => {
  const { claimWaker, pendingNotices, wakeMessage } = await import('../src/wake.mjs');
  const now = Date.parse('2026-11-21T12:00:00Z');
  const job = {
    id: 'j1', executor: 'codexhost', tier: 'review', title: 'look', status: 'completed', verification: 'passed', integration: 'none',
    endedAt: '2026-11-21T11:59:00Z', wake: { via: 'codexhost', thread: 'th' }, turns: [{ n: 1 }],
  };
  assert.deepEqual(pendingNotices([job], 'th', now).map(j => j.id), ['j1']);
  assert.equal(pendingNotices([job], 'other', now).length, 0, 'another Thread\'s job');
  assert.equal(pendingNotices([{ ...job, resultFetchedTurn: 1 }], 'th', now).length, 0, 'the result was read');
  assert.equal(pendingNotices([{ ...job, wake: { ...job.wake, notifiedTurn: 1 } }], 'th', now).length, 0, 'already told');
  assert.equal(pendingNotices([{ ...job, wake: { ...job.wake, notifiedTurn: 1 }, turns: [{ n: 1 }, { n: 2 }] }], 'th', now).length, 1, 'a later turn is told again');
  assert.equal(pendingNotices([{ ...job, takeover: { at: 'x' } }], 'th', now).length, 0, 'taken over');
  assert.equal(pendingNotices([{ ...job, integration: 'applied' }], 'th', now).length, 0, 'applied');
  assert.equal(pendingNotices([{ ...job, status: 'running' }], 'th', now).length, 0, 'still running');
  assert.equal(pendingNotices([{ ...job, endedAt: '2026-11-21T05:00:00Z' }], 'th', now).length, 0, 'given up after six hours');
  assert.match(wakeMessage([{ ...job, status: 'failed', error: { code: 'needs-input' }, turns: [{ n: 1 }, { n: 2 }] }]), /j1 \(codexhost, review\) is waiting for your answer \(turn 2\)/);

  const { dir, cleanup } = makeRepo(FILES);
  try {
    assert.equal(claimWaker(dir, 'th', process.pid), true);
    assert.equal(claimWaker(dir, 'th', process.pid), true, 'its own lock');
    assert.equal(claimWaker(dir, 'th', process.pid + 100_000), false, 'held by a live waker');
    const lock = path.join(dir, '.agenthub', 'wake', 'th.json');
    fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, thread: 'th' }));
    assert.equal(claimWaker(dir, 'th', process.pid), true, 'a dead waker\'s lock is taken over');
  } finally {
    cleanup();
  }
});

test('discarding a job whose Thread waits on a question cancels that turn; the job started under its own request id', async () => {
  const t = setup();
  try {
    const agents = await t.relay.call('relay_agents', {});
    assert.deepEqual(agents.codexhost.harnesses, ['fakeh', 'antigravity', 'claude-code']);
    assert.equal(agents.role, 'planner');
    const { jobId } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ ask: 'Which file?' }) });
    await settle(t.relay, jobId);
    const thread = (await t.relay.call('relay_result', { jobId })).native.sessionId;
    const start = t.host().calls.find(call => call.args[0] === 'delegate');
    assert.equal(start.args[start.args.indexOf('--request-id') + 1], `agenthub-relay-${jobId}`);
    const discarded = await t.relay.call('relay_discard', { jobId });
    assert.equal(discarded.discarded, true);
    assert.ok(t.host().calls.some(call => call.args[1] === 'cancel' && call.args[2] === thread), 'thread cancel on discard');
    assert.equal(t.host().threads[thread].turns.at(-1).interrupted, true);
  } finally {
    t.cleanup();
  }
});

test('a Thread that ends without the turn it was given fails the job with that reason, recorded whole (seen with real harnesses)', async () => {
  const t = setup();
  try {
    const { jobId } = await t.relay.call('relay_dispatch', {
      tier: 'light', executor: 'codexhost/fakeh', scope: ['src/app.txt'], checks: ['node check.mjs src/app.txt'], task: fakeTask({ lostTurn: true }),
    });
    const job = await settle(t.relay, jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'executor-failed', 'not a worker error');
    const result = await t.relay.call('relay_result', { jobId });
    assert.match(result.executorRun.error, /without the turn the relay started/);
    assert.equal(result.summary, '');
    assert.deepEqual(result.checks.map(check => check.status), ['not-run']);
  } finally {
    t.cleanup();
  }
});

/** A stand-in for runProcess that answers each codexhost call from `answer(args, input)`. */
function scripted(answer) {
  const calls = [];
  const run = async ({ argv, stdin, signal }) => {
    const at = argv.findIndex(arg => arg === 'delegate' || arg === 'thread');
    const args = argv.slice(at, -2); // without --format json
    calls.push(args);
    const reply = await answer(args, { stdin, signal, calls });
    return { signal: null, timedOut: false, cancelled: false, durationMs: 1, stdout: '', stderr: '', ...reply };
  };
  return { run, calls };
}

test("an earlier turn's question without a turnId does not turn this turn's old snapshot into needs-input", () => {
  const old = {
    status: 'running',
    turn: { turnId: 't-old', status: 'running' },
    pendingQuestions: [{ kind: 'requestUserInput', request: { questions: [{ question: 'Old question?' }] } }],
  };
  assert.equal(readSnapshot(old, 't-new').state, 'running', "a snapshot of another turn is not this turn's question");
});

test('an asynchronous question answered before the turn ended is not reported as left open', async () => {
  const { driveCodexhost } = await import('../src/codexhost.mjs');
  const job = { id: 'j20261121-000000-cccccc', harness: 'fakeh', title: 'look', timeoutMinutes: 1 };
  const cfg = { command: 'codexhost-not-on-path', modelArgs: [], effortArgs: [], extraArgs: [] };
  let waits = 0;
  const host = scripted(args => {
    if (args[0] === 'delegate') return { exitCode: 0, stdout: JSON.stringify({ threadId: 't-a', turnId: 'u-a' }) };
    if (args[1] === 'wait') {
      waits += 1;
      if (waits === 1) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'running',
            turn: { turnId: 'u-a', status: 'running' },
            pendingQuestions: [{
              interactionId: 'q-a', kind: 'requestUserInputAsync', turnId: 'u-a',
              request: { title: 'Which style?', options: ['a', 'b'] },
            }],
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'completed',
          turn: { turnId: 'u-a', status: 'completed' },
          result: { availability: 'available', text: 'done' },
          pendingQuestions: [],
        }),
      };
    }
    return { exitCode: 1 };
  });
  const out = await driveCodexhost({ job, cfg, prompt: 'task', cwd: '.', env: {}, run: host.run, retryMs: 1 });
  assert.equal(out.parsed.ok, true);
  assert.equal(out.parsed.warnings, undefined, 'the answer arrived, so nothing stays open');
});

test('a stale asynchronous question keeps the retry backoff at retryMs, not one second', async () => {
  const { driveCodexhost } = await import('../src/codexhost.mjs');
  const job = { id: 'j20261121-000000-dddddd', harness: 'fakeh', title: 'look', timeoutMinutes: 1 };
  const cfg = { command: 'codexhost-not-on-path', modelArgs: [], effortArgs: [], extraArgs: [] };
  let waits = 0;
  const host = scripted(args => {
    if (args[0] === 'delegate') return { exitCode: 0, stdout: JSON.stringify({ threadId: 't-b', turnId: 'u-b' }) };
    if (args[1] === 'wait') {
      waits += 1;
      if (waits === 1) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'running',
            turn: { turnId: 'u-b', status: 'running' },
            // The previous turn's asynchronous question is still listed, but
            // its turnId filters it out of this turn's open questions.
            pendingQuestions: [{
              interactionId: 'q-old', kind: 'requestUserInputAsync', turnId: 'u-old',
              request: { title: 'Old question?', options: ['a'] },
            }],
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'completed',
          turn: { turnId: 'u-b', status: 'completed' },
          result: { availability: 'available', text: 'done' },
          pendingQuestions: [],
        }),
      };
    }
    return { exitCode: 1 };
  });
  const started = Date.now();
  const out = await driveCodexhost({ job, cfg, prompt: 'task', cwd: '.', env: {}, run: host.run, retryMs: 3_000 });
  const elapsed = Date.now() - started;
  assert.equal(out.parsed.ok, true);
  assert.ok(elapsed >= 2_000, `the running snapshot made the driver wait retryMs (3 s), not 1 s; elapsed ${elapsed} ms`);
});

test('the driver retries a delegate start that may have reached the Host, under the same request id; a coded refusal is final', async () => {
  const { driveCodexhost } = await import('../src/codexhost.mjs');
  const job = { id: 'j20261121-000000-aaaaaa', harness: 'fakeh', title: 'look', timeoutMinutes: 1 };
  const cfg = { command: 'codexhost-not-on-path', modelArgs: [], effortArgs: [], extraArgs: [] };
  let starts = 0;
  const flaky = scripted(args => {
    if (args[0] === 'delegate') {
      starts += 1;
      return starts === 1 ? { exitCode: null, timedOut: true } : { exitCode: 0, stdout: JSON.stringify({ threadId: 't-1', turnId: 'u-1' }) };
    }
    return { exitCode: 0, stdout: JSON.stringify({ status: 'completed', turn: { turnId: 'u-1', status: 'completed' }, result: { text: 'done' } }) };
  });
  const saved = [];
  const ok = await driveCodexhost({ job, cfg, prompt: 'task', cwd: '.', env: {}, run: flaky.run, retryMs: 1, onSession: id => saved.push(id) });
  assert.equal(ok.parsed.ok, true);
  assert.equal(ok.parsed.summary, 'done');
  assert.deepEqual(saved, ['t-1']);
  const delegates = flaky.calls.filter(args => args[0] === 'delegate');
  assert.equal(delegates.length, 2);
  assert.deepEqual(delegates[0], delegates[1], 'the same call, request id and all');
  assert.equal(delegates[0][delegates[0].indexOf('--request-id') + 1], `agenthub-relay-${job.id}`);

  const refused = scripted(() => ({ exitCode: 1, stderr: JSON.stringify({ error: { code: 'HARNESS_NOT_FOUND', message: 'no fakeh' } }) }));
  const failed = await driveCodexhost({ job, cfg, prompt: 'task', cwd: '.', env: {}, run: refused.run, retryMs: 1 });
  assert.equal(failed.parsed.ok, false);
  assert.match(failed.parsed.error, /HARNESS_NOT_FOUND/);
  assert.equal(refused.calls.length, 1);
});

test('a cancel that does not get through is tried again, then left on record', async () => {
  const { driveCodexhost } = await import('../src/codexhost.mjs');
  const job = { id: 'j20261121-000000-bbbbbb', harness: 'fakeh', title: 'look', timeoutMinutes: 1 };
  const cfg = { command: 'codexhost-not-on-path', modelArgs: [], effortArgs: [], extraArgs: [] };
  const controller = new AbortController();
  const host = scripted(args => {
    if (args[0] === 'delegate') {
      controller.abort(); // the job is cancelled while its turn starts
      return { exitCode: 0, stdout: JSON.stringify({ threadId: 't-2', turnId: 'u-2' }) };
    }
    if (args[1] === 'cancel') return { exitCode: 1, stderr: JSON.stringify({ error: { code: 'RUNTIME_UNREACHABLE', message: 'restarting' } }) };
    return { exitCode: 1 };
  });
  const out = await driveCodexhost({ job, cfg, prompt: 'task', cwd: '.', env: {}, run: host.run, retryMs: 1, signal: controller.signal });
  assert.equal(out.run.cancelled, true);
  assert.equal(host.calls.filter(args => args[1] === 'cancel').length, 3);
  assert.match(out.parsed.warnings[0], /could not cancel the turn of codexhost Thread t-2.*RUNTIME_UNREACHABLE/);

  // A Thread that is gone has nothing left to stop: one call, no warning.
  const stopped = new AbortController();
  const gone = scripted(args => {
    if (args[0] === 'delegate') {
      stopped.abort();
      return { exitCode: 0, stdout: JSON.stringify({ threadId: 't-3', turnId: 'u-3' }) };
    }
    return { exitCode: 1, stderr: JSON.stringify({ error: { code: 'THREAD_NOT_FOUND', message: 'no t-3' } }) };
  });
  const quiet = await driveCodexhost({ job, cfg, prompt: 'task', cwd: '.', env: {}, run: gone.run, retryMs: 1, signal: stopped.signal });
  assert.equal(gone.calls.filter(args => args[1] === 'cancel').length, 1);
  assert.equal(quiet.parsed.warnings, undefined);
});

test('the waker ends a job whose worker died and tells its planner once, also after a send that timed out but arrived', async () => {
  const { runWaker } = await import('../src/wake.mjs');
  const { createStore, newJobId } = await import('../src/store.mjs');
  const { dir, cleanup } = makeRepo(FILES);
  try {
    const store = createStore(dir);
    const lost = async () => {
      const id = newJobId();
      store.create({
        id, title: 'lost one', tier: 'review', executor: 'codex', write: false, scope: ['.'], checks: [],
        wake: { via: 'codexhost', thread: 'th-9' }, turns: [{ n: 1, kind: 'dispatch', by: 'planner', status: 'queued' }],
      });
      await store.update(id, draft => {
        draft.status = 'running';
        draft.heartbeatAt = new Date(Date.now() - 10 * 60_000).toISOString();
        draft.worker = { pid: 2_147_483_000 };
        draft.turns[0].status = 'running';
      });
      return id;
    };
    const first = await lost();
    const sends = [];
    // The send times out, yet the message is the Thread's newest turn.
    const arrived = scripted((args, { stdin }) => {
      if (args[1] === 'send') {
        sends.push(stdin);
        return { exitCode: null, timedOut: true };
      }
      // As a Windows channel may give it back: with CRLF line ends.
      if (args[1] === 'read') return { exitCode: 0, stdout: JSON.stringify({ turns: [{ turnNumber: 3, messages: [{ role: 'user', text: sends.at(-1).replace(/\n/g, '\r\n') }] }] }) };
      return { exitCode: 1 };
    });
    const outcome = await runWaker({ root: dir, thread: 'th-9', env: {}, command: 'codexhost-not-on-path', run: arrived.run, tickMs: 10 });
    assert.equal(outcome.stopped, 'idle');
    assert.equal(sends.length, 1, 'it arrived: not sent again');
    assert.match(sends[0], /ended failed: lost one/);
    const ended = store.read(first);
    assert.equal(ended.error.code, 'worker-lost', 'the waker reconciled it; nothing else would have');
    assert.equal(ended.wake.notifiedTurn, 1);

    // One that timed out and did not arrive is sent again.
    const second = await lost();
    let tries = 0;
    const lostSend = scripted(args => {
      if (args[1] === 'send') return ++tries === 1 ? { exitCode: null, timedOut: true } : { exitCode: 0, stdout: '{}' };
      if (args[1] === 'read') return { exitCode: 0, stdout: JSON.stringify({ turns: [] }) };
      return { exitCode: 1 };
    });
    await runWaker({ root: dir, thread: 'th-9', env: {}, command: 'codexhost-not-on-path', run: lostSend.run, tickMs: 10 });
    assert.equal(tries, 2);
    assert.equal(store.read(second).wake.notifiedTurn, 1);
  } finally {
    cleanup();
  }
});
