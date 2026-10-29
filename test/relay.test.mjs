import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { notRun, runChecks, runProcess, TIMEOUT_EXIT_CODE, verdict } from '../src/checks.mjs';
import { loadConfig } from '../src/config.mjs';
import {
  addWorktree,
  applyPatch,
  branchName,
  collectChanges,
  ensureExcluded,
  removeWorktree,
  repoRoot,
  snapshotBase,
} from '../src/git.mjs';
import { planDispatch } from '../src/policy.mjs';
import { createStore, isAlive, newJobId } from '../src/store.mjs';
import { runWorker } from '../src/worker.mjs';
import { fakeTask, git, listFiles, makeRepo, sleep, tempDir, useFakeExecutors, waitFor } from './helpers.mjs';

/** What relay_dispatch does before it starts a worker, for in-process tests. */
async function prepareJob(root, request) {
  const config = loadConfig({ root, env: process.env });
  const store = createStore(root);
  const plan = planDispatch({ request, config, jobs: store.list() });
  const id = newJobId();
  const base = await snapshotBase(root);
  await ensureExcluded(root);
  const { dir, branch } = await addWorktree(root, id, base.commit);
  store.create({ id, ...plan, base, worktree: path.relative(root, dir), branch, passEnv: config.executors[plan.executor].passEnv });
  return id;
}

describe('git isolation', () => {
  test('a clean tree starts from HEAD; uncommitted changes go into a snapshot, untracked files are reported', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, 'rev-parse', 'HEAD');
      const clean = await snapshotBase(dir);
      assert.equal(clean.commit, head);
      assert.equal(clean.includesUncommitted, false);
      assert.equal(clean.untrackedCount, 0);

      fs.writeFileSync(path.join(dir, 'src/app.txt'), 'app edited\n');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'untracked\n');
      const dirty = await snapshotBase(dir);
      assert.notEqual(dirty.commit, head);
      assert.equal(dirty.includesUncommitted, true);
      assert.deepEqual(dirty.untracked, ['notes.txt']);

      const { dir: wt } = await addWorktree(dir, 'j20261029-000000-aaaaaa', dirty.commit);
      assert.equal(fs.readFileSync(path.join(wt, 'src/app.txt'), 'utf8'), 'app edited\n');
      assert.equal(fs.existsSync(path.join(wt, 'notes.txt')), false);
      // Taking the snapshot leaves the main tree exactly as it was.
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'app edited\n');
      assert.match(git(dir, 'status', '--porcelain'), /src\/app\.txt/);
    } finally {
      cleanup();
    }
  });

  test('changes stay in the worktree until the patch is applied, then the worktree and branch are removed', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      await ensureExcluded(dir);
      await ensureExcluded(dir);
      const exclude = fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8');
      assert.equal(exclude.split('\n').filter(line => line === '.agenthub/').length, 1);

      const id = 'j20261029-000001-bbbbbb';
      const base = await snapshotBase(dir);
      const { dir: wt, branch } = await addWorktree(dir, id, base.commit);
      assert.equal(branch, branchName(id));
      assert.equal(git(dir, 'status', '--porcelain'), '', '.agenthub/ is excluded from status');

      fs.writeFileSync(path.join(wt, 'src/app.txt'), 'changed by executor\n');
      fs.mkdirSync(path.join(wt, 'src/new'), { recursive: true });
      fs.writeFileSync(path.join(wt, 'src/new/file.bin'), Buffer.from([0, 1, 2, 255]));
      fs.rmSync(path.join(wt, 'src/api/x.txt'));
      const changes = await collectChanges(wt, base.commit);
      assert.deepEqual(changes.files.sort(), ['src/api/x.txt', 'src/app.txt', 'src/new/file.bin']);
      assert.match(changes.stat, /3 files changed/);
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'app\n', 'main tree untouched');

      const patchFile = path.join(dir, '.agenthub', 'patch.diff');
      fs.writeFileSync(patchFile, changes.patch);
      await applyPatch(dir, patchFile);
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'changed by executor\n');
      assert.deepEqual([...fs.readFileSync(path.join(dir, 'src/new/file.bin'))], [0, 1, 2, 255]);
      assert.equal(fs.existsSync(path.join(dir, 'src/api/x.txt')), false);

      await removeWorktree(dir, id);
      assert.equal(fs.existsSync(wt), false);
      assert.equal(git(dir, 'branch', '--list', branch), '');
    } finally {
      cleanup();
    }
  });

  test('a patch that no longer applies is refused before anything changes', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      const base = await snapshotBase(dir);
      const { dir: wt } = await addWorktree(dir, 'j20261029-000002-cccccc', base.commit);
      fs.writeFileSync(path.join(wt, 'src/app.txt'), 'executor version\n');
      const changes = await collectChanges(wt, base.commit);
      const patchFile = path.join(dir, '.agenthub', 'conflict.diff');
      fs.writeFileSync(patchFile, changes.patch);
      fs.writeFileSync(path.join(dir, 'src/app.txt'), 'planner version\n');
      await assert.rejects(applyPatch(dir, patchFile), err => err.code === 'apply-conflict');
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'planner version\n');

      const empty = path.join(dir, '.agenthub', 'empty.diff');
      fs.writeFileSync(empty, '');
      await assert.rejects(applyPatch(dir, empty), err => err.code === 'nothing-to-apply');
    } finally {
      cleanup();
    }
  });

  test('a folder outside git, or a repository without commits, is refused', async () => {
    const outside = tempDir();
    const bare = tempDir();
    try {
      await assert.rejects(repoRoot(outside.dir), err => err.code === 'not-a-git-repo');
      git(bare.dir, 'init', '-q');
      await assert.rejects(snapshotBase(bare.dir), err => err.code === 'no-commits');
    } finally {
      outside.cleanup();
      bare.cleanup();
    }
  });
});

describe('checks', () => {
  test('exit 0 passes, non-zero fails, a timeout records 124, and the process group is ended', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const pidFile = path.join(dir, 'grandchild.pid');
      const results = await runChecks(['true', 'echo boom >&2; exit 3', `sleep 300 & echo $! > ${pidFile}; wait`], {
        cwd: dir,
        env: process.env,
        timeoutMs: 400,
        logDir: dir,
      });
      assert.deepEqual(results.map(r => [r.status, r.exitCode]), [['passed', 0], ['failed', 3], ['failed', TIMEOUT_EXIT_CODE]]);
      assert.match(results[1].summary, /^exit 3: boom/);
      assert.match(results[2].summary, /timed out/);
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitFor(() => !isAlive(grandchild), { what: 'the timed-out group to end' });
      assert.match(fs.readFileSync(path.join(dir, '1.log'), 'utf8'), /boom/);
    } finally {
      cleanup();
    }
  });

  test('a job is completed only when the executor succeeded and every check passed', () => {
    const passed = { status: 'passed', exitCode: 0 };
    const failed = { status: 'failed', exitCode: 1 };
    assert.deepEqual(verdict({ executorOk: true, checks: [] }), { status: 'completed', verification: 'unverified' });
    assert.deepEqual(verdict({ executorOk: true, checks: [passed] }), { status: 'completed', verification: 'passed' });
    assert.deepEqual(verdict({ executorOk: true, checks: [passed, failed] }), { status: 'failed', verification: 'failed' });
    assert.deepEqual(verdict({ executorOk: false, checks: notRun(['npm test'], 'not run') }), { status: 'failed', verification: 'not-run' });
    assert.deepEqual(notRun(['a'], 'why'), [{ command: 'a', status: 'not-run', exitCode: null, summary: 'why' }]);
  });

  test('a command that cannot start resolves with the spawn error', async () => {
    const run = await runProcess({ argv: ['/definitely/missing/binary'], cwd: process.cwd(), env: process.env });
    assert.equal(run.spawnError.code, 'ENOENT');
  });
});

describe('worker', () => {
  test('runs the executor in its worktree, audits the scope and records passing checks', async () => {
    const { dir, cleanup } = makeRepo();
    const scratch = tempDir();
    process.env.AGENTHUB_TEST_SECRET = 'secret-value-never-recorded';
    try {
      useFakeExecutors(dir, { codex: { passEnv: ['AGENTHUB_TEST_SECRET'] } });
      const record = path.join(scratch.dir, 'seen.json');
      const id = await prepareJob(dir, {
        tier: 'deep',
        scope: ['src/api'],
        checks: ['test -f src/api/new.txt'],
        task: fakeTask({
          write: { 'src/api/new.txt': 'new\n', 'README.md': '# rewritten\n' },
          message: 'added src/api/new.txt',
          record,
          envNames: ['AGENTHUB_TEST_SECRET', 'HOME_NOT_PASSED_XYZ'],
        }),
      });
      const job = await runWorker({ root: dir, jobId: id, env: { ...process.env, HOME_NOT_PASSED_XYZ: '1' } });
      assert.equal(job.status, 'completed');
      assert.equal(job.verification, 'passed');
      assert.deepEqual(job.changedFiles.sort(), ['README.md', 'src/api/new.txt']);
      assert.deepEqual(job.outOfScope, ['README.md']);
      assert.equal(job.summary, 'added src/api/new.txt');
      assert.deepEqual(job.checkResults.map(c => [c.status, c.exitCode]), [['passed', 0]]);
      assert.deepEqual(job.passedEnv, ['AGENTHUB_TEST_SECRET']);
      assert.equal(job.executorRun.sessionId, 'fake-thread');

      const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.equal(seen.mode, 'codex');
      assert.equal(seen.role, 'executor');
      assert.equal(seen.job, id);
      assert.deepEqual(seen.present, { AGENTHUB_TEST_SECRET: true, HOME_NOT_PASSED_XYZ: false });
      assert.equal(fs.realpathSync(seen.cwd), path.join(dir, '.agenthub', 'worktrees', id));
      assert.match(seen.prompt, /scope: src\/api/);

      assert.equal(fs.existsSync(path.join(dir, 'src/api/new.txt')), false, 'main tree untouched');
      assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# demo\n');
      for (const file of listFiles(path.join(dir, '.agenthub', 'jobs'))) {
        assert.ok(!fs.readFileSync(file, 'utf8').includes('secret-value-never-recorded'), `${file} holds a value`);
      }
    } finally {
      delete process.env.AGENTHUB_TEST_SECRET;
      scratch.cleanup();
      cleanup();
    }
  });

  test('a failing check fails the job; a failing executor leaves the checks not run', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      useFakeExecutors(dir);
      const checkFails = await prepareJob(dir, {
        tier: 'light',
        scope: ['src/app.txt'],
        checks: ['grep -q never src/app.txt'],
        task: fakeTask({ write: { 'src/app.txt': 'changed\n' } }),
      });
      const failedChecks = await runWorker({ root: dir, jobId: checkFails });
      assert.equal(failedChecks.executor, 'dsh');
      assert.equal(failedChecks.status, 'failed');
      assert.equal(failedChecks.verification, 'failed');
      assert.equal(failedChecks.error.code, 'checks-failed');
      assert.deepEqual(failedChecks.checkResults.map(c => [c.status, c.exitCode]), [['failed', 1]]);

      const executorFails = await prepareJob(dir, {
        tier: 'review',
        checks: ['true'],
        task: fakeTask({ fail: true }),
      });
      const failedRun = await runWorker({ root: dir, jobId: executorFails });
      assert.equal(failedRun.executor, 'claude');
      assert.equal(failedRun.status, 'failed');
      assert.equal(failedRun.error.code, 'executor-failed');
      assert.match(failedRun.error.message, /error_during_execution/);
      assert.deepEqual(failedRun.checkResults, [{ command: 'true', status: 'not-run', exitCode: null, summary: 'not run: the executor did not finish successfully' }]);
      assert.equal(failedRun.verification, 'not-run');
    } finally {
      cleanup();
    }
  });

  test('an executor that runs past its timeout is stopped with its whole process group', async () => {
    const { dir, cleanup } = makeRepo();
    const scratch = tempDir();
    try {
      useFakeExecutors(dir);
      const pidFile = path.join(scratch.dir, 'child.pid');
      const id = await prepareJob(dir, {
        tier: 'deep',
        scope: ['src'],
        timeoutMinutes: 0.01,
        task: fakeTask({ spawnChild: pidFile, sleepMs: 60_000 }),
      });
      const job = await runWorker({ root: dir, jobId: id });
      assert.equal(job.status, 'failed');
      assert.equal(job.error.code, 'executor-timeout');
      assert.equal(job.executorRun.timedOut, true);
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitFor(() => !isAlive(grandchild), { what: 'the executor group to end' });
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  test('cancelling stops the executor and ends the job cancelled', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      useFakeExecutors(dir);
      const id = await prepareJob(dir, { tier: 'deep', scope: ['src'], checks: ['true'], task: fakeTask({ sleepMs: 60_000 }) });
      const controller = new AbortController();
      const running = runWorker({ root: dir, jobId: id, signal: controller.signal });
      const store = createStore(dir);
      await waitFor(() => store.read(id).status === 'running', { what: 'the job to start' });
      await sleep(300);
      controller.abort();
      const job = await running;
      assert.equal(job.status, 'cancelled');
      assert.equal(job.checkResults[0].status, 'not-run');
    } finally {
      cleanup();
    }
  });

  test('a read-only review that writes anyway has every change reported out of scope', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      useFakeExecutors(dir);
      const id = await prepareJob(dir, { tier: 'review', task: fakeTask({ write: { 'src/app.txt': 'oops\n' } }) });
      const job = await runWorker({ root: dir, jobId: id });
      assert.equal(job.status, 'completed');
      assert.equal(job.verification, 'unverified');
      assert.deepEqual(job.outOfScope, ['src/app.txt']);
      assert.ok(job.warnings.some(w => /read-only review changed files/.test(w)));
    } finally {
      cleanup();
    }
  });
});
