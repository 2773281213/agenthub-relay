import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { checkTransition, createStore, isAlive, isJobId, isLost, newJobId } from '../src/store.mjs';
import { listFiles, ROOT, tempDir } from './helpers.mjs';

const STORE_URL = pathToFileURL(path.join(ROOT, 'src', 'store.mjs')).href;

function sampleJob(id = newJobId(), extra = {}) {
  return {
    id,
    title: 'demo',
    task: 'demo task',
    tier: 'deep',
    write: true,
    executor: 'codex',
    scope: ['src'],
    checks: [],
    passEnv: ['DEMO_SECRET'],
    worktree: `.agenthub/worktrees/${id}`,
    branch: `agenthub/${id}`,
    ...extra,
  };
}

test('job ids are sortable and path-safe; other strings are refused', () => {
  const id = newJobId(new Date(Date.UTC(2026, 9, 29, 6, 15, 30)));
  assert.match(id, /^j20261029-061530-[0-9a-f]{6}$/);
  assert.ok(isJobId(id));
  const { dir, cleanup } = tempDir();
  try {
    const store = createStore(dir);
    for (const bad of ['../x', 'j1', `${id}/../../etc`]) {
      assert.throws(() => store.read(bad), err => err.code === 'unknown-job');
    }
  } finally {
    cleanup();
  }
});

test('the state machine refuses illegal transitions and double integration', () => {
  const base = { ...sampleJob(), status: 'queued', integration: 'none' };
  assert.doesNotThrow(() => checkTransition(base, { ...base, status: 'running' }));
  assert.throws(() => checkTransition(base, { ...base, status: 'verifying' }), err => err.code === 'invalid-transition');
  const done = { ...base, status: 'completed' };
  assert.throws(() => checkTransition(done, { ...done, status: 'running' }), err => err.code === 'invalid-transition');
  assert.doesNotThrow(() => checkTransition(done, { ...done, integration: 'applied' }));
  const applied = { ...done, integration: 'applied' };
  assert.throws(() => checkTransition(applied, { ...applied, integration: 'discarded' }), err => err.code === 'invalid-transition');
  const running = { ...base, status: 'running' };
  assert.throws(() => checkTransition(running, { ...running, integration: 'applied' }), err => err.code === 'invalid-transition');
  assert.throws(() => checkTransition(base, { ...base, executor: 'dsh' }), err => err.code === 'invalid-transition');
});

test('create, update and list keep an event log and never record environment values', async () => {
  const { dir, cleanup } = tempDir();
  const previous = process.env.DEMO_SECRET;
  process.env.DEMO_SECRET = 'value-that-must-not-be-stored';
  try {
    const store = createStore(dir);
    const job = store.create(sampleJob());
    assert.equal(job.status, 'queued');
    assert.equal(job.integration, 'none');
    await store.update(job.id, draft => {
      draft.status = 'running';
    });
    await store.update(job.id, draft => {
      draft.status = 'verifying';
    });
    const done = await store.update(job.id, draft => {
      draft.status = 'completed';
    });
    assert.equal(done.status, 'completed');
    assert.equal(store.list().length, 1);
    const events = fs.readFileSync(store.paths(job.id).events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.type === 'status' ? e.to : e.type), ['created', 'running', 'verifying', 'completed']);
    for (const file of listFiles(store.dir)) {
      assert.ok(!fs.readFileSync(file, 'utf8').includes('value-that-must-not-be-stored'), `${file} leaked a value`);
    }
    assert.deepEqual(store.read(job.id).passEnv, ['DEMO_SECRET']);
  } finally {
    if (previous === undefined) delete process.env.DEMO_SECRET;
    else process.env.DEMO_SECRET = previous;
    cleanup();
  }
});

test('updates from several processes at once are serialized by the lock', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = createStore(dir);
    const job = store.create(sampleJob(undefined, { counter: 0 }));
    const script = `
      import { createStore } from ${JSON.stringify(STORE_URL)};
      const store = createStore(process.argv[1]);
      for (let i = 0; i < 15; i++) await store.update(process.argv[2], d => { d.counter += 1; });
    `;
    const children = Array.from({ length: 4 }, () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, job.id], { stdio: 'inherit' });
        child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
      }),
    );
    await Promise.all(children);
    assert.equal(store.read(job.id).counter, 60);
    assert.ok(!fs.existsSync(store.paths(job.id).lock));
  } finally {
    cleanup();
  }
});

test('a live job whose worker vanished is reconciled to failed (worker-lost)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = createStore(dir);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(dead.stdout);
    assert.equal(isAlive(deadPid), false);
    const old = new Date(Date.now() - 2 * 60_000).toISOString();

    const lost = store.create(sampleJob());
    await store.update(lost.id, d => {
      d.status = 'running';
      d.worker = { pid: deadPid };
      d.heartbeatAt = old;
    });
    const fresh = store.create(sampleJob(undefined, { scope: ['docs'] }));
    await store.update(fresh.id, d => {
      d.status = 'running';
      d.worker = { pid: process.pid };
      d.heartbeatAt = new Date().toISOString();
    });

    assert.equal(isLost(store.read(lost.id)), true);
    assert.equal(isLost(store.read(fresh.id)), false);
    const reconciled = await store.reconcile(store.read(lost.id));
    assert.equal(reconciled.status, 'failed');
    assert.equal(reconciled.error.code, 'worker-lost');
    assert.equal((await store.reconcile(store.read(fresh.id))).status, 'running');
  } finally {
    cleanup();
  }
});

test('listing a repository that never dispatched creates nothing', () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.deepEqual(createStore(dir).list(), []);
    assert.equal(fs.existsSync(path.join(dir, '.agenthub')), false);
  } finally {
    cleanup();
  }
});
