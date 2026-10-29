// Configuration layers, planner profiles, models and `config set`, and how
// the dispatch policy picks a job's model and effort.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { buildConfig, loadConfig, parseRoute, plannerFromName, userConfigPath, writeSetting } from '../src/config.mjs';
import { planDispatch } from '../src/policy.mjs';
import { tempDir } from './helpers.mjs';

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

/** A project root and a user config file, isolated from the real home. */
function layout() {
  const { dir, cleanup } = tempDir();
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const env = { AGENTHUB_RELAY_USER_CONFIG: path.join(dir, 'user', 'config.json') };
  return { root, env, userFile: env.AGENTHUB_RELAY_USER_CONFIG, projectFile: path.join(root, '.agenthub', 'config.json'), cleanup };
}

test('the planner name maps planner ids and MCP client names', () => {
  assert.equal(plannerFromName('codex'), 'codex');
  assert.equal(plannerFromName('codex-mcp-client'), 'codex');
  assert.equal(plannerFromName('claude-code'), 'claude');
  assert.equal(plannerFromName('Antigravity'), 'agy');
  assert.equal(plannerFromName('deepseek-harness'), 'dsh');
  assert.equal(plannerFromName('cursor'), 'unknown');
  assert.equal(plannerFromName(undefined), 'unknown');
});

test('a planner without configuration gets its built-in profile', () => {
  assert.equal(buildConfig({ planner: 'claude' }).profile, 'thread16');
  const codex = buildConfig({ planner: 'codex' });
  assert.equal(codex.profile, 'codex-planner');
  assert.equal(codex.mapping.deep, 'claude', 'a Codex planner does not get its deep work back');
  assert.match(codex.profileReason, /built-in default for a codex planner/);
  assert.equal(buildConfig({ planner: 'unknown' }).profile, 'thread16');
});

test('profile precedence: environment, file plannerProfiles, file profile, built-in planner default', () => {
  const profiles = { mine: { deep: 'claude', light: 'dsh', review: 'claude' }, other: { deep: 'codex', light: 'dsh', review: 'codex' } };
  const withFile = data => [{ file: 'f.json', data: { profiles, ...data } }];
  assert.equal(buildConfig({ layers: withFile({ profile: 'mine' }), planner: 'codex' }).profile, 'mine', 'a file profile beats the built-in planner default');
  assert.equal(buildConfig({ layers: withFile({ profile: 'mine', plannerProfiles: { codex: 'other' } }), planner: 'codex' }).profile, 'other');
  assert.equal(buildConfig({ layers: withFile({ profile: 'mine', plannerProfiles: { codex: 'other' } }), planner: 'claude' }).profile, 'mine');
  const fromEnv = buildConfig({ layers: withFile({ profile: 'mine' }), planner: 'codex', env: { AGENTHUB_RELAY_PROFILE: 'thread16' } });
  assert.equal(fromEnv.profile, 'thread16');
  assert.equal(fromEnv.profileReason, 'AGENTHUB_RELAY_PROFILE');
});

test('tier routes can carry a model and an effort; the mapping stays executor names', () => {
  const config = buildConfig({
    layers: [{ file: 'f.json', data: { profiles: { thread16: { deep: { executor: 'claude', model: 'opus', effort: 'high' } } } } }],
  });
  assert.deepEqual({ ...config.routes.deep }, { executor: 'claude', model: 'opus', effort: 'high' });
  assert.equal(config.mapping.deep, 'claude');
  assert.equal(config.mapping.light, 'dsh', 'tiers not overridden keep the built-in route');
});

test('invalid models, routes and planner profiles are refused', () => {
  const bad = data => () => buildConfig({ layers: [{ file: 'f.json', data }] });
  assert.throws(bad({ executors: { codex: { model: 'gpt 5; rm -rf' } } }), err => err.code === 'config-invalid');
  assert.throws(bad({ profiles: { thread16: { deep: { executor: 'nope' } } } }), err => err.code === 'config-invalid');
  assert.throws(bad({ profiles: { thread16: { deep: { executor: 'codex', speed: 1 } } } }), err => err.code === 'config-invalid');
  assert.throws(bad({ plannerProfiles: { cursor: 'thread16' } }), err => err.code === 'config-invalid');
  assert.throws(bad({ plannerProfiles: { codex: 'missing' } }), err => err.code === 'config-invalid');
  assert.throws(bad({ executors: { codex: { modelArgs: ['--model'] } } }), err => err.code === 'config-invalid' && /\{model\}/.test(err.message));
});

test('the project file overrides the user file, which overrides the defaults', () => {
  const { root, env, userFile, projectFile, cleanup } = layout();
  try {
    writeJson(userFile, { executors: { codex: { model: 'user-model', timeoutMinutes: 5 } }, profile: 'codex-planner' });
    writeJson(projectFile, { executors: { codex: { model: 'project-model' } } });
    const config = loadConfig({ root, env });
    assert.equal(config.executors.codex.model, 'project-model');
    assert.equal(config.executors.codex.timeoutMinutes, 5, 'settings the project does not set come from the user file');
    assert.equal(config.profile, 'codex-planner');
    assert.deepEqual(config.sources, [userFile, projectFile]);
  } finally {
    cleanup();
  }
});

test('the user file defaults to XDG_CONFIG_HOME, then ~/.config', () => {
  assert.equal(userConfigPath({ XDG_CONFIG_HOME: '/x' }), path.join('/x', 'agenthub-relay', 'config.json'));
  assert.equal(userConfigPath({ HOME: '/h' }), path.join('/h', '.config', 'agenthub-relay', 'config.json'));
  assert.equal(userConfigPath({}), null);
});

test('route values parse as executor[:model][@effort]', () => {
  assert.equal(parseRoute('codex'), 'codex');
  assert.deepEqual(parseRoute('claude:opus@high'), { executor: 'claude', model: 'opus', effort: 'high' });
  assert.deepEqual(parseRoute('codex@medium'), { executor: 'codex', effort: 'medium' });
  assert.deepEqual(parseRoute('codex:gpt-5.1-codex'), { executor: 'codex', model: 'gpt-5.1-codex' });
  assert.throws(() => parseRoute('Codex:x'), err => err.code === 'invalid-value');
});

test('config set writes a validated value and leaves the file alone when it is invalid', () => {
  const { root, env, projectFile, cleanup } = layout();
  try {
    writeSetting({ file: projectFile, key: 'profiles.thread16.deep', value: 'claude:opus@high' });
    writeSetting({ file: projectFile, key: 'executors.codex.timeoutMinutes', value: '30' });
    writeSetting({ file: projectFile, key: 'plannerProfiles.codex', value: 'thread16' });
    const config = loadConfig({ root, env, planner: 'codex' });
    assert.deepEqual({ ...config.routes.deep }, { executor: 'claude', model: 'opus', effort: 'high' });
    assert.equal(config.executors.codex.timeoutMinutes, 30);
    assert.equal(config.profile, 'thread16');

    const before = fs.readFileSync(projectFile, 'utf8');
    assert.throws(() => writeSetting({ file: projectFile, key: 'profiles.thread16.light', value: 'nope' }), err => err.code === 'config-invalid');
    assert.throws(() => writeSetting({ file: projectFile, key: 'executors.codex.passEnv', value: 'SECRET' }), err => err.code === 'invalid-key');
    assert.throws(() => writeSetting({ file: projectFile, key: 'executors.codex.model', value: 'a b' }), err => err.code === 'config-invalid');
    assert.equal(fs.readFileSync(projectFile, 'utf8'), before);

    const removed = writeSetting({ file: projectFile, key: 'plannerProfiles.codex', unset: true });
    assert.equal(removed.removed, true);
    assert.equal(loadConfig({ root, env, planner: 'codex' }).profile, 'codex-planner');
  } finally {
    cleanup();
  }
});

test('a job takes its model from the request, then the route, then the executor default', () => {
  const config = buildConfig({
    layers: [{
      file: 'f.json',
      data: {
        profiles: { thread16: { deep: { executor: 'codex', model: 'route-model', effort: 'high' } } },
        executors: { claude: { model: 'claude-default' } },
      },
    }],
  });
  const request = extra => ({ task: 'x', tier: 'deep', scope: ['src'], ...extra });
  const fromRoute = planDispatch({ request: request(), config });
  assert.equal(fromRoute.model, 'route-model');
  assert.equal(fromRoute.effort, 'high');
  assert.equal(planDispatch({ request: request({ model: 'asked', effort: 'low' }), config }).model, 'asked');
  const otherExecutor = planDispatch({ request: request({ executor: 'claude' }), config });
  assert.equal(otherExecutor.model, 'claude-default', "the route's model is for its own executor only");
  assert.equal(otherExecutor.effort, undefined);
  assert.equal(planDispatch({ request: { task: 'x', tier: 'review' }, config }).model, 'claude-default', 'review routes to claude, whose default applies');
  assert.equal(planDispatch({ request: { task: 'x', tier: 'deep', scope: ['src'] }, config: buildConfig({}) }).model, undefined, 'no model unless one is set');
});

test('an executor without a model or effort flag refuses one, with the reason', () => {
  const config = buildConfig({});
  const light = { task: 'x', tier: 'light', scope: ['a.txt'], checks: ['true'] };
  assert.throws(
    () => planDispatch({ request: { ...light, model: 'deepseek-flash' }, config }),
    err => err.code === 'model-unsupported' && /dsh/.test(err.message) && err.details.executor === 'dsh',
  );
  assert.throws(() => planDispatch({ request: { ...light, effort: 'high' }, config }), err => err.code === 'effort-unsupported');
  assert.throws(() => planDispatch({ request: { ...light, executor: 'codex', model: 'bad name' }, config }), err => err.code === 'invalid-request');
  const custom = buildConfig({ layers: [{ file: 'f.json', data: { executors: { dsh: { modelArgs: ['--model', '{model}'] } } } }] });
  assert.equal(planDispatch({ request: { ...light, model: 'deepseek-flash' }, config: custom }).model, 'deepseek-flash');
});
