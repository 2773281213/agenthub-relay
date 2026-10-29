// The command line as a planner without MCP uses it: dispatch, wait, result,
// apply, discard and cancel, planner identity, models, settings, the
// executor role and exit codes. Real git repositories, the fake executor.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createRelay } from '../src/tools.mjs';
import { CLI, fakeTask, makeRepo, tempDir, useFakeExecutors } from './helpers.mjs';

/** Runs the CLI in a repository with an isolated user config file. */
function cli(root, args, { input, env = {}, script = CLI } = {}) {
  const base = { ...process.env };
  for (const name of ['AGENTHUB_RELAY_PLANNER', 'AGENTHUB_RELAY_PROFILE', 'AGENTHUB_RELAY_ROLE', 'AGENTHUB_RELAY_CONFIG', 'CLAUDE_PROJECT_DIR']) delete base[name];
  const run = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...base, AGENTHUB_RELAY_ROOT: root, AGENTHUB_RELAY_USER_CONFIG: path.join(root, '.test-user-config.json'), ...env },
  });
  let json;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    json = undefined;
  }
  return { code: run.status, json, stdout: run.stdout, stderr: run.stderr };
}

function setup() {
  const repo = makeRepo();
  useFakeExecutors(repo.dir);
  fs.appendFileSync(path.join(repo.dir, '.git', 'info', 'exclude'), '.test-user-config.json\n');
  return repo;
}

function jobRecord(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, '.agenthub', 'jobs', id, 'job.json'), 'utf8'));
}

/** Waits through the CLI until the job ends. */
function waitDone(root, id) {
  for (let i = 0; i < 6; i += 1) {
    const waited = cli(root, ['wait', id, '--timeout', '20']);
    assert.equal(waited.code, 0, waited.stderr);
    if (waited.json.finished.length) return waited.json.finished[0];
  }
  throw new Error(`job ${id} did not finish`);
}

test('a planner runs dispatch, wait, result and apply through the CLI', () => {
  const { dir, cleanup } = setup();
  try {
    const task = fakeTask({ write: { 'src/app.txt': 'from the cli\n' }, message: 'edited src/app.txt' });
    const dispatched = cli(dir, ['dispatch', '--tier', 'light', '--scope', 'src/app.txt', '--check', 'grep -q cli src/app.txt', '--task-file', '-', '--planner', 'claude'], { input: task });
    assert.equal(dispatched.code, 0, dispatched.stderr || dispatched.stdout);
    assert.equal(dispatched.json.executor, 'dsh');
    assert.equal(dispatched.json.planner, 'claude');
    assert.equal(dispatched.json.watcher, undefined, 'a one-shot CLI process has no watcher to report');
    const id = dispatched.json.jobId;

    const finished = waitDone(dir, id);
    assert.equal(finished.status, 'completed');

    const status = cli(dir, ['status', '--json']);
    assert.equal(status.code, 0);
    assert.equal(status.json.jobs[0].id, id);
    assert.equal(status.json.running, 0);
    assert.equal(status.json.watcher, undefined);

    const result = cli(dir, ['result', id]);
    assert.equal(result.json.summary, 'edited src/app.txt');
    assert.deepEqual(result.json.changedFiles, ['src/app.txt']);
    assert.equal(result.json.checks[0].status, 'passed');

    assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'app\n', 'nothing reaches the working tree before apply');
    const applied = cli(dir, ['apply', id]);
    assert.equal(applied.code, 0, applied.stdout);
    assert.equal(applied.json.applied, true);
    assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'from the cli\n');

    const record = jobRecord(dir, id);
    assert.deepEqual(record.planner, { client: 'cli', id: 'claude', profile: 'thread16' });
    assert.equal(record.integration, 'applied');

    const human = cli(dir, ['status']);
    assert.match(human.stdout, new RegExp(`${id}\\s+completed/applied`));
  } finally {
    cleanup();
  }
});

test('the planner picks the profile and a job can name its model', () => {
  const { dir, cleanup } = setup();
  try {
    const record = path.join(dir, '..', `${path.basename(dir)}-argv.json`);
    const task = fakeTask({ record, message: 'deep done' });
    const dispatched = cli(dir, ['dispatch', '--tier', 'deep', '--scope', 'src', '--task', task, '--model', 'opus', '--effort', 'high', '--planner', 'codex']);
    assert.equal(dispatched.code, 0, dispatched.stdout);
    assert.equal(dispatched.json.profile, 'codex-planner');
    assert.equal(dispatched.json.executor, 'claude', "a Codex planner's deep work goes to Claude Code");
    assert.equal(dispatched.json.model, 'opus');
    waitDone(dir, dispatched.json.jobId);
    const argv = JSON.parse(fs.readFileSync(record, 'utf8')).args;
    assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 4), ['--model', 'opus', '--effort', 'high']);
    const job = jobRecord(dir, dispatched.json.jobId);
    assert.equal(job.model, 'opus');
    assert.equal(job.effort, 'high');
    assert.equal(cli(dir, ['status', dispatched.json.jobId]).json.job.model, 'opus');
    assert.equal(cli(dir, ['discard', dispatched.json.jobId]).json.discarded, true);
    fs.rmSync(record, { force: true });

    const fromEnv = cli(dir, ['agents'], { env: { AGENTHUB_RELAY_PLANNER: 'codex' } });
    assert.equal(fromEnv.json.planner, 'codex');
    assert.equal(fromEnv.json.profile, 'codex-planner');

    const refused = cli(dir, ['dispatch', '--tier', 'light', '--scope', 'a.txt', '--check', 'true', '--task', 'x', '--model', 'deepseek-flash']);
    assert.equal(refused.code, 1);
    assert.equal(refused.json.error.code, 'model-unsupported');
  } finally {
    cleanup();
  }
});

test('config show, set and unset change the routing for later dispatches', () => {
  const { dir, cleanup } = setup();
  try {
    const set = cli(dir, ['config', 'set', 'profiles.thread16.deep', 'claude:opus@high']);
    assert.equal(set.code, 0, set.stdout + set.stderr);
    assert.equal(set.json.file, path.join(dir, '.agenthub', 'config.json'));
    const shown = cli(dir, ['config', 'show', '--json']);
    assert.deepEqual(shown.json.routes.deep, { executor: 'claude', model: 'opus', effort: 'high' });
    assert.equal(shown.json.profile, 'thread16');

    const user = cli(dir, ['config', 'set', 'executors.codex.model', 'gpt-5.1-codex', '--user']);
    assert.equal(user.code, 0);
    assert.equal(user.json.file, path.join(dir, '.test-user-config.json'));
    assert.equal(cli(dir, ['config', 'show', '--json']).json.executors.find(e => e.id === 'codex').model, 'gpt-5.1-codex');

    const bad = cli(dir, ['config', 'set', 'profiles.thread16.light', 'nobody']);
    assert.equal(bad.code, 1);
    assert.equal(bad.json.error.code, 'config-invalid');
    const secret = cli(dir, ['config', 'set', 'executors.codex.passEnv', 'OPENAI_API_KEY']);
    assert.equal(secret.json.error.code, 'invalid-key', 'credentials are not settable from the command line');

    assert.equal(cli(dir, ['config', 'unset', 'profiles.thread16.deep']).code, 0);
    assert.equal(cli(dir, ['config', 'show', '--json']).json.routes.deep.executor, 'codex');
    assert.match(cli(dir, ['config', 'show']).stdout, /profile: thread16/);
  } finally {
    cleanup();
  }
});

test('an executor may neither dispatch nor change settings', () => {
  const { dir, cleanup } = setup();
  try {
    const env = { AGENTHUB_RELAY_ROLE: 'executor' };
    const dispatched = cli(dir, ['dispatch', '--tier', 'deep', '--scope', '.', '--task', 'x'], { env });
    assert.equal(dispatched.code, 1);
    assert.equal(dispatched.json.error.code, 'executor-role');
    const set = cli(dir, ['config', 'set', 'profile', 'codex-planner'], { env });
    assert.equal(set.code, 1);
    assert.equal(set.json.error.code, 'executor-role');
    assert.equal(fs.existsSync(path.join(dir, '.agenthub', 'jobs')), false);
  } finally {
    cleanup();
  }
});

test('usage errors exit 2 without touching the repository', () => {
  const { dir, cleanup } = setup();
  try {
    for (const args of [
      ['dispatch', '--task', 'x'],
      ['dispatch', '--tier', 'deep'],
      ['dispatch', '--tier', 'deep', '--task', 'x', '--task-file', 'y'],
      ['dispatch', '--tier', 'deep', '--task', 'x', '--planner', 'cursor'],
      ['dispatch', '--tier', 'deep', '--task', 'x', '--bogus'],
      ['apply'],
      ['wait', '--timeout', 'soon'],
      ['config', 'set', 'profile'],
      ['nonsense'],
    ]) {
      const run = cli(dir, args);
      assert.equal(run.code, 2, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /agenthub-relay:/);
    }
    assert.equal(fs.existsSync(path.join(dir, '.agenthub', 'jobs')), false);
  } finally {
    cleanup();
  }
});

test('cancel stops a running job from the CLI', () => {
  const { dir, cleanup } = setup();
  try {
    const dispatched = cli(dir, ['dispatch', '--tier', 'deep', '--scope', 'src', '--task', fakeTask({ sleepMs: 60_000 })]);
    assert.equal(dispatched.code, 0, dispatched.stdout);
    const id = dispatched.json.jobId;
    const cancelled = cli(dir, ['cancel', id]);
    assert.equal(cancelled.code, 0, cancelled.stdout);
    assert.equal(waitDone(dir, id).status, 'cancelled');
  } finally {
    cleanup();
  }
});

test('the wait limit belongs to the caller: 50 seconds over MCP, longer from the CLI', async () => {
  const { dir, cleanup } = setup();
  const env = { ...process.env, AGENTHUB_RELAY_ROOT: dir, AGENTHUB_RELAY_USER_CONFIG: path.join(dir, '.test-user-config.json') };
  delete env.AGENTHUB_RELAY_ROLE;
  try {
    const mcpLike = createRelay({ cwd: dir, env, maxWaitSeconds: 1 });
    const { jobId } = await mcpLike.call('relay_dispatch', { tier: 'deep', scope: ['src'], task: fakeTask({ sleepMs: 60_000 }) });
    let started = Date.now();
    const clamped = await mcpLike.call('relay_wait', { jobIds: [jobId], timeoutSeconds: 120 });
    assert.equal(clamped.timedOut, true);
    assert.ok(Date.now() - started < 5_000, 'a 120-second request is cut to the 1-second limit');

    const cliLike = createRelay({ cwd: dir, env, maxWaitSeconds: 3600 });
    started = Date.now();
    const longer = await cliLike.call('relay_wait', { jobIds: [jobId], timeoutSeconds: 3 });
    assert.equal(longer.timedOut, true);
    assert.ok(Date.now() - started >= 2_500, 'a longer limit lets the caller wait as long as it asked');
    await cliLike.call('relay_cancel', { jobId });
    assert.equal(waitDone(dir, jobId).status, 'cancelled');
  } finally {
    cleanup();
  }
});
