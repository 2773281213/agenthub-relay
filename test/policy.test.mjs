import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULT_CONFIG, loadConfig } from '../src/config.mjs';
import { covers, normalizeScopePath, outOfScope, planDispatch, PolicyError, scopesOverlap } from '../src/policy.mjs';
import { tempDir } from './helpers.mjs';

const config = loadConfig({ env: {} });

function refused(fn, code) {
  assert.throws(fn, err => err instanceof PolicyError && err.code === code, `expected ${code}`);
}

test('scope paths follow the Birdview path rule', () => {
  assert.equal(normalizeScopePath('src/api/'), 'src/api');
  assert.equal(normalizeScopePath('./src/app.txt'), 'src/app.txt');
  assert.equal(normalizeScopePath('.'), '.');
  for (const bad of ['/etc/passwd', '../x', 'src/../x', '.git/config', 'a//b', 'C:\\x', 'a\\b', 'src/.git']) {
    refused(() => normalizeScopePath(bad), 'invalid-scope');
  }
});

test('directory-prefix matching covers children but not siblings with a common prefix', () => {
  assert.ok(covers('src/api', 'src/api/x.ts'));
  assert.ok(covers('src/api', 'src/api'));
  assert.ok(!covers('src/api', 'src/api-other.ts'));
  assert.ok(covers('.', 'anything/at/all'));
  assert.deepEqual(scopesOverlap(['src/api'], ['src/api/x.ts']), { left: 'src/api', right: 'src/api/x.ts' });
  assert.equal(scopesOverlap(['src/api'], ['src/api-other.ts']), null);
  assert.deepEqual(outOfScope(['src/api/a.ts', 'README.md'], ['src/api']), ['README.md']);
});

test('the default profile is the thread-16 split', () => {
  assert.deepEqual(config.mapping, { deep: 'codex', light: 'dsh', review: 'claude' });
  const deep = planDispatch({ config, request: { task: 'Refactor the parser', tier: 'deep', scope: ['src'] } });
  assert.equal(deep.executor, 'codex');
  assert.equal(deep.write, true);
  const review = planDispatch({ config, request: { task: 'Review the design', tier: 'review' } });
  assert.equal(review.executor, 'claude');
  assert.equal(review.write, false);
  assert.deepEqual(review.scope, ['.']);
});

test('an executor process may not dispatch', () => {
  refused(
    () => planDispatch({ config, role: 'executor', request: { task: 'x', tier: 'review' } }),
    'executor-role',
  );
});

test('reserved executors fail closed with a reason', () => {
  for (const executor of ['agy', 'acp']) {
    assert.throws(
      () => planDispatch({ config, request: { task: 'x', tier: 'review', executor } }),
      err => err.code === 'reserved-executor' && /reserved/.test(err.message) && err.details.executor === executor,
    );
  }
  refused(() => planDispatch({ config, request: { task: 'x', tier: 'review', executor: 'opencode' } }), 'unknown-executor');
});

test('a light job needs an explicit scope of at most 10 entries and at least one check', () => {
  refused(() => planDispatch({ config, request: { task: 'x', tier: 'light', checks: ['true'] } }), 'light-needs-scope');
  refused(() => planDispatch({ config, request: { task: 'x', tier: 'light', scope: ['a.txt'] } }), 'light-needs-checks');
  const eleven = Array.from({ length: 11 }, (_, i) => `f${i}.txt`);
  refused(
    () => planDispatch({ config, request: { task: 'x', tier: 'light', scope: eleven, checks: ['true'] } }),
    'light-scope-too-wide',
  );
  refused(
    () => planDispatch({ config, request: { task: 'x', tier: 'light', scope: ['.'], checks: ['true'] } }),
    'light-scope-too-wide',
  );
  const ok = planDispatch({ config, request: { task: 'x', tier: 'light', scope: ['a.txt'], checks: ['npm test'] } });
  assert.equal(ok.executor, 'dsh');
  assert.deepEqual(ok.checks, ['npm test']);
});

test('a deep job must declare its scope', () => {
  refused(() => planDispatch({ config, request: { task: 'x', tier: 'deep' } }), 'deep-needs-scope');
});

test('write jobs may not overlap a live or unintegrated write job', () => {
  const base = { write: true, integration: 'none' };
  const jobs = [
    { ...base, id: 'j-live', status: 'running', scope: ['src/api'] },
    { ...base, id: 'j-done', status: 'completed', scope: ['docs'] },
    { ...base, id: 'j-failed', status: 'failed', scope: ['lib'] },
    { ...base, id: 'j-applied', status: 'completed', integration: 'applied', scope: ['pkg'] },
    { id: 'j-review', write: false, status: 'running', scope: ['.'] },
  ];
  const request = scope => ({ task: 'x', tier: 'deep', scope });
  refused(() => planDispatch({ config, jobs, request: request(['src/api/x.ts']) }), 'scope-conflict');
  refused(() => planDispatch({ config, jobs, request: request(['src']) }), 'scope-conflict');
  refused(() => planDispatch({ config, jobs, request: request(['docs/guide.md']) }), 'scope-conflict');
  refused(() => planDispatch({ config, jobs, request: request(['.']) }), 'scope-conflict');
  for (const free of [['src/api-other.ts'], ['lib'], ['pkg']]) {
    assert.doesNotThrow(() => planDispatch({ config, jobs, request: request(free) }));
  }
  // A read-only review never conflicts, even with a live write job.
  assert.doesNotThrow(() => planDispatch({ config, jobs, request: { task: 'x', tier: 'review', scope: ['src/api'] } }));
});

test('requests are validated before anything is created', () => {
  refused(() => planDispatch({ config, request: { tier: 'deep', scope: ['a'] } }), 'invalid-request');
  refused(() => planDispatch({ config, request: { task: 'x', tier: 'huge' } }), 'invalid-tier');
  refused(
    () => planDispatch({ config, request: { task: 'x', tier: 'review', checks: Array(21).fill('true') } }),
    'invalid-request',
  );
  const plan = planDispatch({ config, request: { task: '\n  First line\nmore', tier: 'review' } });
  assert.equal(plan.title, 'First line');
});

test('configuration files merge over the defaults and cannot enable reserved executors', () => {
  const { dir, cleanup } = tempDir();
  try {
    fs.mkdirSync(path.join(dir, '.agenthub'));
    const file = path.join(dir, '.agenthub', 'config.json');
    fs.writeFileSync(file, JSON.stringify({ executors: { codex: { command: '/opt/codex', passEnv: ['CODEX_API_KEY'] } } }));
    const loaded = loadConfig({ root: dir, env: {} });
    assert.equal(loaded.executors.codex.command, '/opt/codex');
    assert.deepEqual(loaded.executors.codex.passEnv, ['CODEX_API_KEY']);
    assert.equal(loaded.executors.dsh.command, DEFAULT_CONFIG.executors.dsh.command);
    assert.equal(loaded.source, file);

    const planner = loadConfig({ root: dir, env: { AGENTHUB_RELAY_PROFILE: 'codex-planner' } });
    assert.deepEqual(planner.mapping, { deep: 'claude', light: 'dsh', review: 'codex' });

    fs.writeFileSync(file, JSON.stringify({ executors: { agy: { command: 'agy' } } }));
    assert.throws(() => loadConfig({ root: dir, env: {} }), err => err.code === 'config-invalid' && /reserved/.test(err.message));
    fs.writeFileSync(file, JSON.stringify({ surprise: true }));
    assert.throws(() => loadConfig({ root: dir, env: {} }), err => err.code === 'config-invalid');
    fs.writeFileSync(file, JSON.stringify({ executors: { codex: { passEnv: ['NOT A NAME'] } } }));
    assert.throws(() => loadConfig({ root: dir, env: {} }), err => err.code === 'config-invalid');
    fs.writeFileSync(file, '{ broken');
    assert.throws(() => loadConfig({ root: dir, env: {} }), err => err.code === 'config-invalid');
  } finally {
    cleanup();
  }
});
