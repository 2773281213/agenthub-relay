// The codexhost executor: jobs run as Threads of a codex-host Host through
// its CLI. Real worker processes drive a fake codexhost CLI
// (fixtures/fake-codexhost.mjs) whose Host state lives in CODEXHOST_DATA_DIR.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { readSnapshot, questionsOf, envFor } from '../src/codexhost.mjs';
import { buildConfig, parseRoute } from '../src/config.mjs';
import { isExecutorCaller, planDispatch } from '../src/policy.mjs';
import { routeText, plainRoute } from '../src/session.mjs';
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

      const threadId = result.native.sessionId;
      for (const name of ['CODEXHOST_THREAD_ID', 'CODEX_THREAD_ID']) {
        const inside = createRelay({ cwd: t.dir, env: { ...t.env, [name]: threadId }, clientName: () => 'harness' });
        await assert.rejects(
          inside.call('relay_dispatch', { tier: 'deep', executor: 'codexhost/fakeh', scope: ['docs'], task: fakeTask({}) }),
          err => err.code === 'executor-role',
          `${name} of a waiting job's Thread marks an executor`,
        );
      }

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
    if (process.platform === 'win32') assert.match(discarded.warnings[0], /could not be deleted/);
    assert.equal((await t.relay.call('relay_status', { jobId })).job.integration, 'discarded');
  } finally {
    holder?.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
    t.cleanup();
  }
});

describe('waking a planner that runs in a codexhost Thread', () => {
  /** A planner Thread in the fake Host; `busyUntil` keeps its current turn active. */
  function seedPlanner(t, id, busyUntil = 0) {
    const file = path.join(t.env.CODEXHOST_DATA_DIR, 'fake-host.json');
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { threads: {}, calls: [] };
    state.threads[id] = { harness: 'planner', cwd: t.dir, title: 'planner', turns: [{ turnId: 'p-1', input: 'plan', readyAt: busyUntil, outcome: 'completed', text: '', questions: [] }] };
    fs.writeFileSync(file, JSON.stringify(state));
  }

  test('the jobs that end are told to the planner Thread in one message once its busy turn ends', async () => {
    const planner = '11111111-2222-4333-8444-555555555555';
    const t = setup({ CODEXHOST_THREAD_ID: planner, AGENTHUB_RELAY_WAKE_TICK_MS: '200' });
    try {
      seedPlanner(t, planner, Date.now() + 8_000);
      const a = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', title: 'look at a', task: fakeTask({ message: 'a' }) });
      const b = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', title: 'look at b', task: fakeTask({ message: 'b' }) });
      assert.equal(a.watcher.active, true, 'a planner the Host can reach is told it will be woken');
      assert.equal(a.watcher.via, 'codexhost');
      await settle(t.relay, a.jobId);
      await settle(t.relay, b.jobId);

      const woken = await waitFor(() => {
        const turns = t.host().threads[planner].turns;
        return turns.length > 1 ? turns : undefined;
      }, { timeoutMs: 30_000, what: 'the wake' });
      assert.equal(woken.length, 2, 'both jobs in one message');
      assert.match(woken[1].input, /2 jobs you dispatched have ended/);
      assert.ok(woken[1].input.includes(a.jobId) && woken[1].input.includes(b.jobId));
      assert.ok(t.host().calls.some(call => call.args[1] === 'send' && call.args[2] === planner), 'sent to the planner');
      const busy = t.host().calls.filter(call => call.args[1] === 'send' && call.args[2] === planner);
      assert.ok(busy.length >= 1);
      const { job } = await t.relay.call('relay_status', { jobId: a.jobId });
      assert.equal(job.wake.notifiedTurn, 1);

      const agents = await t.relay.call('relay_agents', {});
      assert.equal(agents.wake.via, 'codexhost');
      assert.equal(agents.planners.codex.keepAlive, 'unsupported');
    } finally {
      t.cleanup();
    }
  });

  test('a Thread the Host does not know, or a planner outside codexhost, is not promised a wake', async () => {
    const t = setup({ CODEX_THREAD_ID: '99999999-2222-4333-8444-555555555555' });
    try {
      const { watcher, jobId } = await t.relay.call('relay_dispatch', { tier: 'review', executor: 'codexhost/fakeh', task: fakeTask({ message: 'a' }) });
      assert.equal(watcher.active, false);
      assert.equal((await t.relay.call('relay_agents', {})).wake.via, 'relay_wait');
      await settle(t.relay, jobId);
      assert.equal((await t.relay.call('relay_status', { jobId })).job.wake, undefined);
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
