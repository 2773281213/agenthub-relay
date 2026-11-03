// Planner sessions through the relay tools: start lists the saved roles and
// models, confirm keeps them or checks and saves changes, and dispatch works
// only inside a confirmed session of the same planner. Workers are not
// started here; the relay tests cover running jobs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createRelay } from '../src/tools.mjs';
import { makeRepo, tempDir, useFakeExecutors } from './helpers.mjs';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A repository with fake executors that requires sessions, an isolated home, and a relay factory. */
function setup() {
  const repo = makeRepo();
  const home = tempDir('agenthub-home-');
  useFakeExecutors(repo.dir, { top: { sessions: { required: true } } });
  write(path.join(home.dir, '.dsh', 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n');
  write(path.join(home.dir, '.codex', 'config.toml'), 'model = "gpt-5.1-codex"\n');
  const env = {
    PATH: process.env.PATH,
    HOME: home.dir,
    AGENTHUB_RELAY_ROOT: repo.dir,
    AGENTHUB_RELAY_USER_CONFIG: path.join(home.dir, '.config', 'agenthub-relay', 'config.json'),
  };
  const relay = ({ planner, client = 'test-client', extraEnv = {} } = {}) =>
    createRelay({ cwd: repo.dir, env: { ...env, ...extraEnv }, planner, clientName: () => client, startWorker: () => undefined });
  const projectFile = path.join(repo.dir, '.agenthub', 'config.json');
  return {
    dir: repo.dir,
    env,
    relay,
    projectFile,
    cleanup: () => {
      repo.cleanup();
      home.cleanup();
    },
  };
}

const review = { tier: 'review', task: 'Look around.' };

test('start lists the saved roles, models and checks; reuse confirms them; dispatch then works', async () => {
  const { dir, relay, cleanup } = setup();
  try {
    const codex = relay({ planner: 'codex' });
    await assert.rejects(codex.call('relay_dispatch', review), err => err.code === 'session-required');

    const started = await codex.call('relay_session', { action: 'start' });
    assert.equal(started.status, 'needs-confirmation');
    assert.equal(started.planner, 'codex');
    assert.equal(started.profile, 'codex-planner');
    assert.equal(started.lastPlanner, null);
    assert.deepEqual(Object.fromEntries(Object.entries(started.tiers).map(([tier, t]) => [tier, t.route])), { deep: 'claude', light: 'dsh', review: 'codex' });
    assert.equal(started.tiers.light.model, 'deepseek-v4-flash', "dsh's own default is shown");
    assert.match(started.tiers.light.modelFrom, /\.dsh[\\/]settings\.yaml/);
    assert.equal(started.tiers.review.model, 'gpt-5.1-codex');
    assert.equal(started.tiers.review.check.status, 'agent-default');
    assert.deepEqual(started.agents.codex.models, ['gpt-5.1-codex (low/medium/high) default', 'gpt-5.1-codex-mini (low/medium)', 'gpt-5.2 (low/medium/high/xhigh)']);
    assert.ok(started.agents.claude.models.includes('opus'));
    assert.match(started.instruction, /do not decide for the user/);
    assert.ok(fs.existsSync(path.join(dir, '.agenthub', 'sessions', `${started.session}.json`)));

    await assert.rejects(codex.call('relay_dispatch', review), err => err.code === 'session-required', 'a started session is not yet confirmed');
    await assert.rejects(codex.call('relay_dispatch', { ...review, session: started.session }), err => err.code === 'session-required');

    const confirmed = await codex.call('relay_session', { action: 'confirm', reuse: true });
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.source, 'reuse');
    assert.equal(confirmed.written, null, 'keeping the saved roles writes nothing');

    const dispatched = await codex.call('relay_dispatch', review);
    assert.equal(dispatched.session, started.session);
    assert.equal(dispatched.executor, 'codex');
    const job = JSON.parse(fs.readFileSync(path.join(dir, '.agenthub', 'jobs', dispatched.jobId, 'job.json'), 'utf8'));
    assert.equal(job.session, started.session);
    assert.equal(job.planner.id, 'codex');

    const shown = await codex.call('relay_session', { action: 'show' });
    assert.equal(shown.session.status, 'confirmed');
    assert.equal(shown.lastPlanner.planner, 'codex');
    await assert.rejects(codex.call('relay_session', { action: 'confirm', session: started.session, reuse: true }), err => err.code === 'session-confirmed');

    const next = await relay({ planner: 'claude' }).call('relay_session', { action: 'start' });
    assert.equal(next.lastPlanner.planner, 'codex', 'a new session says who planned last');
  } finally {
    cleanup();
  }
});

test('changes are checked first: a bad model saves nothing; good ones are saved for later sessions', async () => {
  const { relay, projectFile, cleanup } = setup();
  try {
    const codex = relay({ planner: 'codex' });
    const before = fs.readFileSync(projectFile, 'utf8');
    const { session } = await codex.call('relay_session', { action: 'start' });

    for (const [args, code] of [
      [{ deep: 'codex:gpt-9' }, 'model-unknown'],
      [{ deep: 'codex:gpt-5.1-codex-mini@high' }, 'effort-unsupported'],
      [{ light: 'dsh:deepseek-v4-pro' }, 'model-unsupported'],
      [{ review: 'agy' }, 'reserved-executor'],
      [{ review: 'claude@extreme' }, 'effort-unsupported'],
      [{ deep: 'cursor' }, 'unknown-executor'],
      [{ deep: 'claude:opus', reuse: true }, 'invalid-request'],
      [{}, 'invalid-request'],
    ]) {
      await assert.rejects(codex.call('relay_session', { action: 'confirm', session, ...args }), err => err.code === code, JSON.stringify(args));
    }
    assert.equal(fs.readFileSync(projectFile, 'utf8'), before, 'nothing was written');
    const dsh = await codex.call('relay_session', { action: 'confirm', session, light: 'dsh:deepseek-v4-pro' }).catch(err => err);
    assert.match(dsh.message, /its default model is deepseek-v4-flash/);
    await assert.rejects(codex.call('relay_dispatch', review), err => err.code === 'session-required', 'a refused confirm leaves the session unconfirmed');

    const confirmed = await codex.call('relay_session', { action: 'confirm', session, deep: 'codex:gpt-5.2@xhigh', review: 'claude:opus@high' });
    assert.equal(confirmed.source, 'changed');
    assert.equal(confirmed.written, projectFile);
    assert.deepEqual(confirmed.warnings, []);
    assert.equal(confirmed.tiers.deep.check.status, 'verified');
    const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    assert.deepEqual(saved.profiles['codex-planner'], { deep: { executor: 'codex', model: 'gpt-5.2', effort: 'xhigh' }, light: 'dsh', review: { executor: 'claude', model: 'opus', effort: 'high' } });
    assert.equal(saved.plannerProfiles.codex, 'codex-planner');

    const dispatched = await codex.call('relay_dispatch', { tier: 'deep', scope: ['src'], task: 'x' });
    assert.equal(dispatched.executor, 'codex');
    assert.equal(dispatched.model, 'gpt-5.2');
    assert.equal(dispatched.effort, 'xhigh');

    // Later edits of the configuration do not change a confirmed session.
    const edited = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    edited.profiles['codex-planner'].deep = 'claude';
    fs.writeFileSync(projectFile, JSON.stringify(edited));
    const again = await codex.call('relay_dispatch', { tier: 'deep', scope: ['docs'], task: 'x' });
    assert.equal(again.executor, 'codex', 'the session keeps its snapshot');

    const later = await relay({ planner: 'codex' }).call('relay_session', { action: 'start' });
    assert.equal(later.tiers.deep.route, 'claude', 'a new session lists what is saved now');
    assert.equal(later.tiers.review.route, 'claude:opus@high');
  } finally {
    cleanup();
  }
});

test('a planner with no saved profile gets its own, so other planners keep theirs', async () => {
  const { relay, projectFile, env, cleanup } = setup();
  try {
    const dsh = relay({ planner: 'dsh' });
    const { session } = await dsh.call('relay_session', { action: 'start' });
    await dsh.call('relay_session', { action: 'confirm', session, deep: 'claude:sonnet' });
    const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    assert.deepEqual(saved.profiles['dsh-planner'], { deep: { executor: 'claude', model: 'sonnet' }, light: 'dsh', review: 'claude' });
    assert.equal(saved.plannerProfiles.dsh, 'dsh-planner');
    const claude = await relay({ planner: 'claude' }).call('relay_session', { action: 'start' });
    assert.equal(claude.tiers.deep.route, 'codex', "Claude Code's thread16 is untouched");

    // --user saves in the user file; a project file that sets the same tier wins, and says so.
    const userFile = env.AGENTHUB_RELAY_USER_CONFIG;
    const second = await dsh.call('relay_session', { action: 'start' });
    const confirmed = await dsh.call('relay_session', { action: 'confirm', session: second.session, deep: 'codex', user: true });
    assert.equal(confirmed.written, userFile);
    assert.equal(JSON.parse(fs.readFileSync(userFile, 'utf8')).profiles['dsh-planner'].deep, 'codex');
    assert.match(confirmed.warnings[0], /deep: codex was saved in .*, but claude:sonnet applies/);
    assert.equal(confirmed.tiers.deep.route, 'claude:sonnet', 'the session uses what applies');
  } finally {
    cleanup();
  }
});

test("another agent cannot dispatch in or confirm a planner's session; an unnamed caller holding it is its planner", async () => {
  const { dir, relay, cleanup } = setup();
  try {
    const codex = relay({ planner: 'codex' });
    const { session } = await codex.call('relay_session', { action: 'start' });
    await assert.rejects(relay({ planner: 'claude' }).call('relay_session', { action: 'confirm', session, reuse: true }), err => err.code === 'planner-mismatch');
    await codex.call('relay_session', { action: 'confirm', session, reuse: true });

    await assert.rejects(
      relay({ planner: 'claude' }).call('relay_dispatch', { ...review, session }),
      err => err.code === 'planner-mismatch' && err.details.planner === 'codex' && err.details.caller === 'claude',
    );
    await assert.rejects(relay({ client: 'claude-code' }).call('relay_dispatch', { ...review, session }), err => err.code === 'planner-mismatch', 'the MCP client name identifies the caller too');

    const unnamed = await relay({ client: 'cli' }).call('relay_dispatch', { ...review, session });
    const job = JSON.parse(fs.readFileSync(path.join(dir, '.agenthub', 'jobs', unnamed.jobId, 'job.json'), 'utf8'));
    assert.deepEqual({ id: job.planner.id, assumed: job.planner.assumed }, { id: 'codex', assumed: true });

    await assert.rejects(relay({ client: 'cursor' }).call('relay_session', { action: 'start' }), err => err.code === 'planner-unknown');
    await assert.rejects(relay().call('relay_dispatch', { ...review, session: 'not-a-session' }), err => err.code === 'unknown-session');
    await assert.rejects(relay().call('relay_dispatch', { ...review, session: 's20200101-000000-abcdef' }), err => err.code === 'unknown-session');
  } finally {
    cleanup();
  }
});

test('an executor may not start or confirm sessions; sessions.required false dispatches without one', async () => {
  const { relay, projectFile, cleanup } = setup();
  try {
    const asExecutor = relay({ planner: 'codex', extraEnv: { AGENTHUB_RELAY_ROLE: 'executor' } });
    await assert.rejects(asExecutor.call('relay_session', { action: 'start' }), err => err.code === 'executor-role');
    await assert.rejects(asExecutor.call('relay_session', { action: 'confirm', session: 's20200101-000000-abcdef', reuse: true }), err => err.code === 'executor-role');

    const config = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    config.sessions.required = false;
    fs.writeFileSync(projectFile, JSON.stringify(config));
    const dispatched = await relay({ planner: 'claude' }).call('relay_dispatch', review);
    assert.equal(dispatched.session, null);
    assert.equal(dispatched.executor, 'claude');
  } finally {
    cleanup();
  }
});
