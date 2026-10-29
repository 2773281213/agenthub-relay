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
import { createRelay } from '../src/tools.mjs';
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

  test('checks run in the configured shell; the default is the platform shell', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const bashOnly = '[[ "relay" == r* ]]';
      const [plain] = await runChecks([bashOnly], { cwd: dir, env: process.env, timeoutMs: 5_000, logDir: dir });
      const [bash] = await runChecks([bashOnly], { cwd: dir, env: process.env, timeoutMs: 5_000, logDir: dir, shell: '/bin/bash' });
      assert.equal(bash.status, 'passed', 'the configured bash understands [[ ]]');
      assert.equal(plain.exitCode !== 0, fs.realpathSync('/bin/sh').endsWith('bash') ? false : true, '/bin/sh runs the default');
    } finally {
      cleanup();
    }
  });

  test('a command whose leftover child holds its pipes still finishes', async () => {
    const { dir, cleanup } = tempDir();
    try {
      // On Windows the tree of an exited process cannot be found; simulate that
      // by not killing the group (platform win32) while a grandchild keeps stdout.
      const started = Date.now();
      const run = await runProcess({
        argv: ['sh', '-c', 'sleep 30 & echo started'],
        cwd: dir,
        env: process.env,
        platform: 'win32',
      });
      assert.equal(run.exitCode, 0);
      assert.match(run.stdout, /started/);
      assert.ok(Date.now() - started < 10_000, 'the close grace period ends the wait');
    } finally {
      cleanup();
    }
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

/** A relay for `dir` with an environment that names the repository explicitly. */
function relayFor(dir, extraEnv = {}) {
  const env = { ...process.env, AGENTHUB_RELAY_ROOT: dir, ...extraEnv };
  delete env.CLAUDE_PROJECT_DIR;
  return createRelay({ cwd: dir, env, clientName: () => 'test-planner' });
}

async function waitDone(relay, jobId) {
  return waitFor(async () => {
    const { job } = await relay.call('relay_status', { jobId });
    return ['completed', 'failed', 'cancelled'].includes(job.status) ? job : undefined;
  }, { timeoutMs: 30_000, what: `job ${jobId}` });
}

describe('relay tools (real worker processes)', () => {
  test('dispatch, wait, result and apply: the main tree changes only on apply', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      useFakeExecutors(dir);
      const relay = relayFor(dir);
      const agents = await relay.call('relay_agents', {});
      assert.equal(agents.profile, 'thread16');
      assert.deepEqual(agents.mapping, { deep: 'codex', light: 'dsh', review: 'claude' });

      const dispatched = await relay.call('relay_dispatch', {
        tier: 'deep',
        scope: ['src'],
        checks: ['test -f src/new.txt'],
        task: fakeTask({ write: { 'src/new.txt': 'from codex\n' }, message: 'wrote src/new.txt' }, 'Add src/new.txt.'),
      });
      assert.equal(dispatched.executor, 'codex');
      assert.equal(dispatched.watcher.active, false);
      assert.equal(dispatched.worktree, `.agenthub/worktrees/${dispatched.jobId}`);

      const waited = await waitFor(async () => {
        const w = await relay.call('relay_wait', { timeoutSeconds: 5 });
        return w.finished.length ? w : undefined;
      }, { timeoutMs: 30_000, what: 'relay_wait' });
      assert.equal(waited.finished[0].id, dispatched.jobId);
      assert.equal(fs.existsSync(path.join(dir, 'src/new.txt')), false);

      const result = await relay.call('relay_result', { jobId: dispatched.jobId });
      assert.equal(result.status, 'completed');
      assert.equal(result.verification, 'passed');
      assert.equal(result.summary, 'wrote src/new.txt');
      assert.deepEqual(result.changedFiles, ['src/new.txt']);
      assert.deepEqual(result.outOfScope, []);
      assert.deepEqual(result.checks.map(c => c.status), ['passed']);
      assert.equal(result.logs.patch, `.agenthub/jobs/${dispatched.jobId}/patch.diff`);
      assert.equal((await relay.call('relay_status', { jobId: dispatched.jobId })).job.resultFetched, true);

      const applied = await relay.call('relay_apply', { jobId: dispatched.jobId });
      assert.equal(applied.applied, true);
      assert.equal(fs.readFileSync(path.join(dir, 'src/new.txt'), 'utf8'), 'from codex\n');
      assert.equal(fs.existsSync(path.join(dir, dispatched.worktree)), false);
      await assert.rejects(relay.call('relay_apply', { jobId: dispatched.jobId }), err => err.code === 'already-integrated');
      assert.equal(git(dir, 'status', '--porcelain'), '?? src/new.txt');
    } finally {
      cleanup();
    }
  });

  test('apply guards: out-of-scope files, failed jobs and read-only reviews', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      useFakeExecutors(dir);
      const relay = relayFor(dir);
      const stray = await relay.call('relay_dispatch', {
        tier: 'deep',
        scope: ['src/api'],
        task: fakeTask({ write: { 'src/api/y.txt': 'y\n', 'README.md': '# changed\n' } }),
      });
      const failed = await relay.call('relay_dispatch', {
        tier: 'light',
        scope: ['docs/a.md'],
        checks: ['false'],
        task: fakeTask({ write: { 'docs/a.md': 'a\n' } }),
      });
      const review = await relay.call('relay_dispatch', { tier: 'review', task: fakeTask({ message: 'looks fine' }) });
      for (const { jobId } of [stray, failed, review]) await waitDone(relay, jobId);

      await assert.rejects(relay.call('relay_apply', { jobId: stray.jobId }), err => err.code === 'out-of-scope' && /README\.md/.test(err.message));
      assert.equal((await relay.call('relay_apply', { jobId: stray.jobId, allowOutOfScope: true })).applied, true);
      assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# changed\n');

      assert.equal((await relay.call('relay_status', { jobId: failed.jobId })).job.status, 'failed');
      await assert.rejects(relay.call('relay_apply', { jobId: failed.jobId }), err => err.code === 'job-not-completed');
      assert.equal((await relay.call('relay_discard', { jobId: failed.jobId })).discarded, true);
      assert.equal(fs.existsSync(path.join(dir, '.agenthub/worktrees', failed.jobId)), false);
      assert.equal(git(dir, 'branch', '--list', `agenthub/${failed.jobId}`), '');

      assert.equal((await relay.call('relay_result', { jobId: review.jobId })).summary, 'looks fine');
      await assert.rejects(relay.call('relay_apply', { jobId: review.jobId }), err => err.code === 'read-only-job');
      const listed = await relay.call('relay_status', {});
      assert.ok(!listed.jobs.some(job => job.id === failed.jobId), 'discarded jobs are hidden');
      assert.ok((await relay.call('relay_status', { all: true })).jobs.some(job => job.id === failed.jobId));
    } finally {
      cleanup();
    }
  });

  test('guards at dispatch: scope conflicts, light without checks, reserved executors, the executor role', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      useFakeExecutors(dir);
      fs.writeFileSync(path.join(dir, 'scratch.txt'), 'untracked\n');
      const relay = relayFor(dir);
      const long = await relay.call('relay_dispatch', { tier: 'deep', scope: ['src'], task: fakeTask({ sleepMs: 60_000 }) });
      assert.ok(long.warnings.some(w => /untracked file\(s\).*scratch\.txt/.test(w)));
      await assert.rejects(
        relay.call('relay_dispatch', { tier: 'deep', scope: ['src/api'], task: 'x' }),
        err => err.code === 'scope-conflict' && err.details.job === long.jobId,
      );
      await assert.rejects(relay.call('relay_dispatch', { tier: 'light', scope: ['docs/x.md'], task: 'x' }), err => err.code === 'light-needs-checks');
      await assert.rejects(relay.call('relay_dispatch', { tier: 'review', executor: 'agy', task: 'x' }), err => err.code === 'reserved-executor');
      const worktrees = fs.readdirSync(path.join(dir, '.agenthub/worktrees'));
      assert.deepEqual(worktrees, [long.jobId], 'refused dispatches create no worktree');

      const asExecutor = relayFor(dir, { AGENTHUB_RELAY_ROLE: 'executor' });
      await assert.rejects(asExecutor.call('relay_dispatch', { tier: 'review', task: 'x' }), err => err.code === 'executor-role');

      await assert.rejects(relay.call('relay_discard', { jobId: long.jobId }), err => err.code === 'job-running');
      const cancel = await relay.call('relay_cancel', { jobId: long.jobId });
      assert.equal(cancel.cancelling, true);
      const ended = await waitDone(relay, long.jobId);
      assert.equal(ended.status, 'cancelled');
      await assert.rejects(relay.call('relay_cancel', { jobId: long.jobId }), err => err.code === 'job-finished');
      // A cancelled job no longer holds its scope.
      await relay.call('relay_discard', { jobId: long.jobId });
      const next = await relay.call('relay_dispatch', { tier: 'deep', scope: ['src/api'], task: fakeTask({}) });
      await waitDone(relay, next.jobId);
    } finally {
      cleanup();
    }
  });

  test('a planner-side watcher polling relay_status is reported to the planner', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      useFakeExecutors(dir);
      const relay = relayFor(dir);
      assert.equal((await relay.call('relay_status', {})).watcher.active, false);
      await relay.call('relay_status', { watch: true });
      const dispatched = await relay.call('relay_dispatch', { tier: 'review', task: fakeTask({}) });
      assert.equal(dispatched.watcher.active, true);
      await waitDone(relay, dispatched.jobId);
      // Another planner session has its own watcher state.
      assert.equal((await relayFor(dir).call('relay_status', {})).watcher.active, false);
    } finally {
      cleanup();
    }
  });

  test('tool input is validated', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      const relay = relayFor(dir);
      await assert.rejects(relay.call('relay_nope', {}), err => err.code === 'unknown-tool');
      await assert.rejects(relay.call('relay_result', { jobId: '../../etc/passwd' }), err => err.code === 'unknown-job');
      await assert.rejects(relay.call('relay_wait', { jobIds: ['nope'] }), err => err.code === 'invalid-request');
      assert.deepEqual(await relay.call('relay_wait', {}), { finished: [], running: [], timedOut: false, note: 'No job is running.' });
      const outside = tempDir();
      try {
        const env = { ...process.env, AGENTHUB_RELAY_ROOT: outside.dir };
        delete env.CLAUDE_PROJECT_DIR;
        await assert.rejects(createRelay({ cwd: outside.dir, env }).call('relay_status', {}), err => err.code === 'not-a-git-repo');
      } finally {
        outside.cleanup();
      }
    } finally {
      cleanup();
    }
  });
});

describe('redaction of credentials passed by name', () => {
  test('values are replaced across chunk and multi-byte boundaries', async () => {
    const { createRedactor, redactText, REDACTED } = await import('../src/checks.mjs');
    const secret = 'sk-live-0123456789';
    const r = createRedactor([secret, 'short']);
    const bytes = Buffer.from(`token=${secret}; é ok ${secret}!`, 'utf8');
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) out += r.push(bytes.subarray(i, i + 3));
    out += r.end();
    assert.equal(out, `token=${REDACTED}; é ok ${REDACTED}!`);
    assert.equal(redactText('a short word', ['short']), 'a short word', 'values under 6 characters are left alone');
  });

  test('an executor that prints a passed credential leaves only [redacted] behind', async () => {
    const { dir, cleanup } = makeRepo();
    const value = 'sk-test-value-9f8e7d6c5b4a';
    process.env.AGENTHUB_LEAKY_TOKEN = value;
    try {
      useFakeExecutors(dir, { codex: { passEnv: ['AGENTHUB_LEAKY_TOKEN'] } });
      const id = await prepareJob(dir, {
        tier: 'deep',
        scope: ['src'],
        checks: ['echo "check sees $AGENTHUB_LEAKY_TOKEN"'],
        task: fakeTask({ message: 'my token is', echoEnv: 'AGENTHUB_LEAKY_TOKEN', writeEnv: { 'src/key.env': 'AGENTHUB_LEAKY_TOKEN' } }),
      });
      const job = await runWorker({ root: dir, jobId: id });
      assert.equal(job.status, 'completed');
      assert.equal(job.summary, 'my token is [redacted]');
      assert.match(job.checkResults[0].summary, /check sees \[redacted\]/);
      for (const file of listFiles(path.join(dir, '.agenthub', 'jobs'))) {
        assert.ok(!fs.readFileSync(file, 'utf8').includes(value), `${path.basename(file)} holds the value`);
      }
      assert.match(fs.readFileSync(path.join(dir, '.agenthub/jobs', id, 'executor.log'), 'utf8'), /debug: \[redacted\]/);
      assert.match(fs.readFileSync(path.join(dir, '.agenthub/jobs', id, 'patch.diff'), 'utf8'), /\+KEY=\[redacted\]/);
      assert.ok(job.warnings.some(w => /credential passed by name into its changes/.test(w)));
    } finally {
      delete process.env.AGENTHUB_LEAKY_TOKEN;
      cleanup();
    }
  });
});
