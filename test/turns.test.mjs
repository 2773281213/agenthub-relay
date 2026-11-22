// Jobs as conversations: follow-up turns on the executor's own session
// (relay_send), handing a job to a person and back (relay_takeover,
// relay_collect), and apply/discard holding the job while they work. Real
// worker processes run the fake executor.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { createStore } from '../src/store.mjs';
import { createRelay } from '../src/tools.mjs';
import { fakeTask, git, makeRepo, tempDir, useFakeExecutors, waitFor } from './helpers.mjs';

/** A check that passes when every named file exists; plain node, so it runs in sh and cmd.exe alike. */
const CHECK = "import fs from 'node:fs';\nprocess.exit(process.argv.slice(2).every(file => fs.existsSync(file)) ? 0 : 1);\n";
const MOVE_BRANCH = "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['checkout', '-q', '-b', 'elsewhere'], { stdio: 'ignore' });\n";
const FILES = { 'README.md': '# demo\n', 'src/app.txt': 'app\n', 'docs/guide.md': 'guide\n', 'check.mjs': CHECK, 'move-branch.mjs': MOVE_BRANCH };

function relayFor(dir, extraEnv = {}, options = {}) {
  const env = { ...process.env, AGENTHUB_RELAY_ROOT: dir, ...extraEnv };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.AGENTHUB_RELAY_ROLE;
  return createRelay({ cwd: dir, env, clientName: () => 'test-planner', ...options });
}

async function settle(relay, jobId) {
  return waitFor(async () => {
    const { job } = await relay.call('relay_status', { jobId });
    return ['completed', 'failed', 'cancelled'].includes(job.status) ? job : undefined;
  }, { timeoutMs: 40_000, what: `job ${jobId}` });
}

/** Settles a job and asserts its status, saying what the job recorded when it is another. */
async function settledAs(relay, jobId, status) {
  const job = await settle(relay, jobId);
  if (job.status !== status) {
    const result = await relay.call('relay_result', { jobId });
    assert.fail(`job ${jobId} ended ${job.status}, not ${status}: ${JSON.stringify({ error: result.error, checks: result.checks, executorRun: result.executorRun, warnings: result.warnings })}`);
  }
  return job;
}

const seen = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jobFile = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, '.agenthub', 'jobs', id, 'job.json'), 'utf8'));

describe('follow-up turns (relay_send)', () => {
  test('codex: the same thread continues in the same worktree; checks run again and the patch covers every turn', async () => {
    const { dir, cleanup } = makeRepo(FILES);
    const scratch = tempDir();
    try {
      useFakeExecutors(dir);
      const relay = relayFor(dir);
      const first = path.join(scratch.dir, 'first.json');
      const second = path.join(scratch.dir, 'second.json');
      const { jobId } = await relay.call('relay_dispatch', {
        tier: 'deep',
        scope: ['src'],
        checks: ['node check.mjs src/a.txt'],
        task: fakeTask({ write: { 'src/a.txt': 'a\n' }, message: 'wrote a', record: first }),
      });
      await settledAs(relay, jobId, 'completed');
      const one = await relay.call('relay_result', { jobId });
      assert.equal(one.turn, 1);
      assert.equal(one.native.sessionId, 'fake-thread');
      assert.ok(one.next.some(step => step.tool === 'relay_send'), 'a resumable job offers a follow-up');

      const sent = await relay.call('relay_send', {
        jobId,
        message: fakeTask({ write: { 'src/b.txt': 'b\n' }, message: 'wrote b', record: second }, 'Also add src/b.txt.'),
      });
      assert.equal(sent.turn, 2);
      assert.equal(sent.status, 'queued');
      const ended = await settle(relay, jobId);
      assert.equal(ended.status, 'completed');
      assert.equal(ended.turn, 2);
      assert.equal(ended.resultFetched, false, 'the second turn is unread although the first was read');

      const two = await relay.call('relay_result', { jobId });
      assert.deepEqual(two.changedFiles.sort(), ['src/a.txt', 'src/b.txt']);
      assert.equal(two.summary, 'wrote b');
      assert.deepEqual(two.turns.map(turn => [turn.n, turn.kind, turn.status]), [[1, 'dispatch', 'completed'], [2, 'send', 'completed']]);
      assert.equal(two.logs.executor, `.agenthub/jobs/${jobId}/turns/2/executor.log`);
      const resumed = seen(second);
      assert.deepEqual(resumed.args.slice(0, 3), ['exec', 'resume', '--json']);
      assert.equal(resumed.args.at(-2), 'fake-thread', 'codex resumes the thread it started');
      assert.ok(resumed.args.includes('sandbox_mode="workspace-write"'), 'the sandbox goes through -c, which resume takes');
      assert.match(resumed.prompt, /follow-up for job .*, turn 2/);
      assert.match(resumed.prompt, /Also add src\/b\.txt\./);
      assert.equal(fs.realpathSync(resumed.cwd), fs.realpathSync(seen(first).cwd), 'the same worktree');

      await relay.call('relay_apply', { jobId });
      assert.equal(fs.readFileSync(path.join(dir, 'src/a.txt'), 'utf8'), 'a\n');
      assert.equal(fs.readFileSync(path.join(dir, 'src/b.txt'), 'utf8'), 'b\n');
      await assert.rejects(relay.call('relay_send', { jobId, message: 'more' }), err => err.code === 'already-integrated');
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  test('claude: the session id is chosen at dispatch and a follow-up resumes it; agy continues its conversation', async () => {
    const { dir, cleanup } = makeRepo(FILES);
    const scratch = tempDir();
    try {
      useFakeExecutors(dir);
      const relay = relayFor(dir);
      const first = path.join(scratch.dir, 'claude-1.json');
      const second = path.join(scratch.dir, 'claude-2.json');
      const claude = await relay.call('relay_dispatch', { tier: 'deep', executor: 'claude', scope: ['src'], task: fakeTask({ record: first }) });
      const chosen = jobFile(dir, claude.jobId).native.sessionId;
      assert.match(chosen, /^[0-9a-f-]{36}$/, 'known before the first turn ends');
      await settle(relay, claude.jobId);
      assert.equal(seen(first).args[seen(first).args.indexOf('--session-id') + 1], chosen);
      await relay.call('relay_send', { jobId: claude.jobId, message: fakeTask({ record: second }, 'Tighten it.') });
      await settle(relay, claude.jobId);
      const resumed = seen(second);
      assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], chosen);
      assert.ok(!resumed.args.includes('--session-id'));
      assert.ok(resumed.args.includes('acceptEdits'), 'a write turn still accepts edits');

      const agyRecord = path.join(scratch.dir, 'agy-2.json');
      const agy = await relay.call('relay_dispatch', { tier: 'deep', executor: 'agy', scope: ['docs'], task: fakeTask({}) });
      await settle(relay, agy.jobId);
      await relay.call('relay_send', { jobId: agy.jobId, message: fakeTask({ record: agyRecord }) });
      await settle(relay, agy.jobId);
      const agyArgs = seen(agyRecord).args;
      assert.equal(agyArgs[agyArgs.indexOf('--conversation') + 1], 'fake-conversation');
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  test('dsh: --json gives the session to continue with --session-id; a dsh without them cannot be continued', async () => {
    const { dir, cleanup } = makeRepo(FILES);
    const scratch = tempDir();
    try {
      useFakeExecutors(dir, { dsh: { passEnv: ['FAKE_DSH_LEGACY'] } });
      const relay = relayFor(dir);
      const first = path.join(scratch.dir, 'dsh-1.json');
      const second = path.join(scratch.dir, 'dsh-2.json');
      const { jobId } = await relay.call('relay_dispatch', {
        tier: 'light',
        scope: ['src/app.txt'],
        checks: ['node check.mjs src/app.txt'],
        task: fakeTask({ write: { 'src/app.txt': 'changed\n' }, message: 'edited', record: first }),
      });
      await settledAs(relay, jobId, 'completed');
      assert.deepEqual(seen(first).args, ['--profile', 'headless', '--json', '-'], 'the task goes on stdin');
      assert.equal((await relay.call('relay_result', { jobId })).summary, 'edited');
      await relay.call('relay_send', { jobId, message: fakeTask({ record: second }) });
      await settle(relay, jobId);
      assert.deepEqual(seen(second).args, ['--profile', 'headless', '--json', '--session-id', 'session-fake-1', '-']);

      const legacy = relayFor(dir, { FAKE_DSH_LEGACY: '1' });
      const old = await legacy.call('relay_dispatch', {
        tier: 'light',
        scope: ['docs/guide.md'],
        checks: ['node check.mjs docs/guide.md'],
        task: fakeTask({ message: 'old dsh' }),
      });
      await settle(legacy, old.jobId);
      assert.equal((await legacy.call('relay_result', { jobId: old.jobId })).summary, 'old dsh');
      await assert.rejects(legacy.call('relay_send', { jobId: old.jobId, message: 'again' }), err => err.code === 'resume-unsupported');
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  test('a running turn needs interrupt; the session id is saved while it runs, and the new turn is not cancelled by the old cancel', async () => {
    const { dir, cleanup } = makeRepo(FILES);
    try {
      useFakeExecutors(dir);
      const relay = relayFor(dir);
      const { jobId } = await relay.call('relay_dispatch', { tier: 'deep', scope: ['src'], task: fakeTask({ announceThenSleepMs: 60_000, threadId: 'thread-early' }) });
      await waitFor(() => jobFile(dir, jobId).native?.sessionId === 'thread-early', { timeoutMs: 20_000, what: 'the thread id to be saved mid-run' });
      await assert.rejects(relay.call('relay_send', { jobId, message: 'redirect' }), err => err.code === 'job-busy');
      const sent = await relay.call('relay_send', { jobId, interrupt: true, message: fakeTask({ message: 'redirected' }, 'Do it differently.') });
      assert.equal(sent.turn, 2);
      const ended = await settle(relay, jobId);
      assert.equal(ended.status, 'completed', 'turn 2 ran: the cancel that stopped turn 1 was cleared');
      const result = await relay.call('relay_result', { jobId });
      assert.deepEqual(result.turns.map(turn => [turn.kind, turn.status]), [['dispatch', 'cancelled'], ['send', 'completed']]);
      assert.equal(result.summary, 'redirected');
    } finally {
      cleanup();
    }
  });

  test('of two sends racing for one finished job only one queues a turn, and a freshly queued turn is not taken for lost', async () => {
    const { dir, cleanup } = makeRepo(FILES);
    try {
      useFakeExecutors(dir);
      const relay = relayFor(dir);
      const { jobId } = await relay.call('relay_dispatch', { tier: 'deep', scope: ['src'], task: fakeTask({}) });
      await settle(relay, jobId);
      // A relay whose workers never start: the job stays queued on a pid that is gone.
      const idle = relayFor(dir, {}, { startWorker: () => 2_147_483_000 });
      const raced = await Promise.allSettled([idle.call('relay_send', { jobId, message: 'one' }), idle.call('relay_send', { jobId, message: 'two' })]);
      assert.deepEqual(raced.map(entry => entry.status).sort(), ['fulfilled', 'rejected']);
      assert.equal(raced.find(entry => entry.status === 'rejected').reason.code, 'job-busy');
      const { job } = await idle.call('relay_status', { jobId });
      assert.equal(job.status, 'queued', 'the old heartbeat and the old worker do not make the new turn lost');
      assert.equal(job.turn, 2);
    } finally {
      cleanup();
    }
  });
});

test('a branch that moves while the checks run keeps their actual verification, not not-run', async () => {
  const { dir, cleanup } = makeRepo(FILES);
  try {
    useFakeExecutors(dir);
    const relay = relayFor(dir);
    const { jobId } = await relay.call('relay_dispatch', {
      tier: 'deep',
      executor: 'codex',
      scope: ['src'],
      checks: ['node move-branch.mjs'],
      task: fakeTask({ write: { 'src/a.txt': 'a\n' }, message: 'wrote a' }),
    });
    const ended = await settle(relay, jobId);
    assert.equal(ended.status, 'failed');
    assert.equal(ended.error, 'branch-diverged');
    const result = await relay.call('relay_result', { jobId });
    assert.deepEqual(result.checks.map(check => check.status), ['passed'], 'the check ran and passed before the branch moved');
    assert.equal(result.verification, 'passed', 'the record keeps what the checks found');
    assert.equal(result.turns.at(-1).verification, 'passed');
    assert.match(result.warnings.join('\n'), /Changes were not collected/);
  } finally {
    cleanup();
  }
});

describe('takeover and collect', () => {
  test('a person takes the job over in its own app, the relay keeps its scope and sends it nothing, and collect re-checks the worktree', async () => {
    const { dir, cleanup } = makeRepo(FILES);
    try {
      useFakeExecutors(dir);
      const opened = [];
      const relay = relayFor(dir, {}, { open: async target => (opened.push(target), { ok: true, pid: 1 }) });
      const { jobId } = await relay.call('relay_dispatch', {
        tier: 'deep',
        scope: ['src'],
        checks: ['node check.mjs src/a.txt src/c.txt'],
        task: fakeTask({ write: { 'src/a.txt': 'a\n' } }),
      });
      await settledAs(relay, jobId, 'failed');

      const taken = await relay.call('relay_takeover', { jobId, open: true });
      assert.equal(taken.sessionId, 'fake-thread');
      assert.equal(taken.app.url, 'codex://threads/fake-thread');
      assert.equal(taken.app.verified, false);
      assert.match(taken.terminal.command, /resume fake-thread$/);
      assert.equal(fs.realpathSync(taken.terminal.cwd), fs.realpathSync(path.join(dir, '.agenthub', 'worktrees', jobId)));
      assert.deepEqual(opened, [{ url: 'codex://threads/fake-thread' }]);
      assert.equal((await relay.call('relay_status', { jobId })).job.takenOver, true);

      await assert.rejects(
        relay.call('relay_dispatch', { tier: 'deep', scope: ['src/app.txt'], task: 'x' }),
        err => err.code === 'scope-conflict' && /taken over/.test(err.message),
        'a failed job that is taken over keeps its scope',
      );
      await assert.rejects(relay.call('relay_send', { jobId, message: 'x' }), err => err.code === 'taken-over');
      await assert.rejects(relay.call('relay_apply', { jobId, force: true }), err => err.code === 'taken-over');
      await assert.rejects(relay.call('relay_discard', { jobId }), err => err.code === 'taken-over');

      // What the person does in the worktree.
      fs.writeFileSync(path.join(taken.cwd, 'src', 'c.txt'), 'by hand\n');
      const collected = await relay.call('relay_collect', { jobId });
      assert.equal(collected.turn, 2);
      const ended = await settle(relay, jobId);
      assert.equal(ended.status, 'completed');
      assert.equal(ended.takenOver, undefined, 'collect ends the takeover');
      const result = await relay.call('relay_result', { jobId });
      assert.deepEqual(result.changedFiles.sort(), ['src/a.txt', 'src/c.txt']);
      assert.deepEqual(result.turns.at(-1), { ...result.turns.at(-1), kind: 'collect', by: 'user', status: 'completed', verification: 'passed' });
      assert.equal(git(taken.cwd, 'diff', '--cached', '--name-only'), '', "collecting leaves the worktree's own index alone");
      assert.equal((await relay.call('relay_apply', { jobId })).applied, true);
      assert.equal(fs.readFileSync(path.join(dir, 'src/c.txt'), 'utf8'), 'by hand\n');
    } finally {
      cleanup();
    }
  });

  test('a running job is taken over only with stop; Claude Code opens in the desktop app; a moved branch is not collected', async () => {
    const { dir, cleanup } = makeRepo(FILES);
    try {
      useFakeExecutors(dir);
      const opened = [];
      const relay = relayFor(dir, { CLAUDECODE: '1' }, { open: async target => (opened.push(target), { ok: true, pid: 1 }) });
      const { jobId } = await relay.call('relay_dispatch', { tier: 'deep', executor: 'claude', scope: ['src'], checks: ['node check.mjs README.md'], task: fakeTask({ sleepMs: 60_000 }) });
      await waitFor(async () => (await relay.call('relay_status', { jobId })).job.status === 'running', { what: 'the job to start' });
      await assert.rejects(relay.call('relay_takeover', { jobId }), err => err.code === 'job-running');
      const taken = await relay.call('relay_takeover', { jobId, stop: true, open: true });
      assert.equal(taken.stopped, true);
      assert.equal((await relay.call('relay_status', { jobId })).job.status, 'cancelled');
      const session = jobFile(dir, jobId).native.sessionId;
      assert.deepEqual(opened[0].argv.slice(1), ['--desktop', '--resume', session]);
      assert.equal(fs.realpathSync(opened[0].cwd), fs.realpathSync(taken.cwd));
      assert.match(taken.terminal.command, new RegExp(`--resume ${session}$`));

      git(taken.cwd, 'checkout', '-q', '-b', 'elsewhere');
      await relay.call('relay_collect', { jobId });
      const ended = await settle(relay, jobId);
      assert.equal(ended.status, 'failed');
      assert.equal(ended.error, 'branch-diverged');
      // Found before the checks, which are not run on a worktree that left its branch.
      const result = await relay.call('relay_result', { jobId });
      assert.deepEqual(result.checks.map(check => check.status), ['not-run']);
      assert.match(result.checks[0].summary, /left the job's branch/);

      // A session named on a hand-back is checked: an unconfirmed one is refused.
      const started = await relay.call('relay_session', { action: 'start', planner: 'claude' });
      await assert.rejects(relay.call('relay_collect', { jobId, session: started.session }), err => err.code === 'session-required');
    } finally {
      cleanup();
    }
  });
});

test('a Claude Code job whose first turn never started leaves no session to continue; an executor may not discard it', async () => {
  const { dir, cleanup } = makeRepo(FILES);
  try {
    useFakeExecutors(dir, { claude: { command: path.join(dir, 'no-such-claude.exe') } });
    const relay = relayFor(dir);
    const { jobId } = await relay.call('relay_dispatch', { tier: 'review', executor: 'claude', task: fakeTask({ message: 'x' }) });
    const job = await settle(relay, jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.resumable, false, 'the id chosen at dispatch names no session');
    assert.equal(jobFile(dir, jobId).native.sessionId, undefined);
    await assert.rejects(relay.call('relay_send', { jobId, message: 'again' }), err => err.code === 'resume-unsupported');

    const executor = createRelay({ cwd: dir, env: { ...process.env, AGENTHUB_RELAY_ROOT: dir, AGENTHUB_RELAY_ROLE: 'executor' }, clientName: () => 'executor' });
    for (const tool of ['relay_discard', 'relay_apply', 'relay_cancel']) {
      await assert.rejects(executor.call(tool, { jobId, force: true }), err => err.code === 'executor-role', tool);
    }
    assert.equal((await relay.call('relay_discard', { jobId })).discarded, true);
  } finally {
    cleanup();
  }
});

describe('apply and discard reserve the job', () => {
  test('two applies at once apply once; a reserved job holds its scope; an abandoned reservation is recovered either way', async () => {
    const { dir, cleanup } = makeRepo(FILES);
    try {
      useFakeExecutors(dir);
      const relay = relayFor(dir);
      const one = await relay.call('relay_dispatch', { tier: 'deep', scope: ['src'], task: fakeTask({ write: { 'src/a.txt': 'a\n' } }) });
      await settledAs(relay, one.jobId, "completed");
      const raced = await Promise.allSettled([relay.call('relay_apply', { jobId: one.jobId }), relay.call('relay_apply', { jobId: one.jobId })]);
      assert.equal(raced.filter(entry => entry.status === 'fulfilled').length, 1);
      assert.ok(['job-busy', 'already-integrated'].includes(raced.find(entry => entry.status === 'rejected').reason.code));
      assert.equal(fs.readFileSync(path.join(dir, 'src/a.txt'), 'utf8'), 'a\n');

      const store = createStore(dir);
      const two = await relay.call('relay_dispatch', { tier: 'deep', scope: ['docs'], task: fakeTask({ write: { 'docs/new.md': 'new\n' } }) });
      await settledAs(relay, two.jobId, "completed");
      // An apply in progress (this process holds it): the scope stays claimed.
      await store.update(two.jobId, draft => {
        Object.assign(draft, { integration: 'applying', integrationPid: process.pid, integrationAt: new Date().toISOString() });
      });
      await assert.rejects(relay.call('relay_dispatch', { tier: 'deep', scope: ['docs/sub'], task: 'x' }), err => err.code === 'scope-conflict');
      await assert.rejects(relay.call('relay_send', { jobId: two.jobId, message: 'x' }), err => err.code === 'job-busy');
      // Its process died before the patch landed: the job is unintegrated again.
      await store.update(two.jobId, draft => {
        draft.integrationPid = 2_147_483_000;
      });
      assert.equal((await relay.call('relay_status', { jobId: two.jobId })).job.integration, 'none');
      // Died after the patch landed: recorded as applied.
      git(dir, 'apply', path.join(dir, '.agenthub', 'jobs', two.jobId, 'patch.diff'));
      await store.update(two.jobId, draft => {
        Object.assign(draft, { integration: 'applying', integrationPid: 2_147_483_000, integrationAt: new Date().toISOString() });
      });
      assert.equal((await relay.call('relay_status', { jobId: two.jobId })).job.integration, 'applied');
    } finally {
      cleanup();
    }
  });
});
