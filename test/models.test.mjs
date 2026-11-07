// The model catalog: codex's app-server model list, Claude Code's aliases and
// API list, each agent's own default model read from its settings, the cache,
// and the check of a route. Settings files live in temporary homes; the agent
// configuration files are only ever read.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import {
  agentDefault, catalogFor, checkRoute, CLAUDE_ALIASES, listAgyModels, listClaudeModels, listCodexModels, modelsCachePath, parseAgyModels, tomlTopLevel,
} from '../src/models.mjs';
import { isAlive } from '../src/store.mjs';
import { fakeAgent, sleep, tempDir, waitFor } from './helpers.mjs';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** An isolated home with no agent settings, and an environment that uses it. */
function home() {
  const { dir, cleanup } = tempDir('agenthub-home-');
  const env = { PATH: process.env.PATH, HOME: dir, AGENTHUB_RELAY_USER_CONFIG: path.join(dir, '.config', 'agenthub-relay', 'config.json') };
  return { dir, env, cleanup };
}

const config = () => ({ executors: { codex: { command: fakeAgent() } } });

test('codex models come from app-server model/list, page by page, with their efforts', async () => {
  const models = await listCodexModels({ command: fakeAgent(), env: process.env });
  assert.deepEqual(models.map(m => m.id), ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.2'], 'two pages were read');
  assert.deepEqual(models[0], {
    id: 'gpt-5.1-codex', model: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex', isDefault: true, hidden: false, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
  });
  assert.deepEqual(models[2].efforts, ['low', 'medium', 'high', 'xhigh']);
});

test('a codex that hangs, errs, exits or is missing gives a coded error, and its process ends', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const pidFile = path.join(dir, 'pid');
    await assert.rejects(
      listCodexModels({ command: fakeAgent(), env: { ...process.env, FAKE_APP_SERVER: 'hang', FAKE_APP_SERVER_PID: pidFile }, timeoutMs: 400 }),
      err => err.code === 'model-list-timeout',
    );
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitFor(() => !isAlive(pid), { timeoutMs: 5_000, what: 'the app-server to end' });

    await assert.rejects(listCodexModels({ command: fakeAgent(), env: { ...process.env, FAKE_APP_SERVER: 'error' } }), err => err.code === 'model-list-failed' && /fake model\/list failure/.test(err.message));
    await assert.rejects(listCodexModels({ command: fakeAgent(), env: { ...process.env, FAKE_APP_SERVER: 'exit' } }), err => err.code === 'model-list-failed' && /not signed in/.test(err.message));
    await assert.rejects(listCodexModels({ command: 'agenthub-no-such-codex', env: process.env }), err => err.code === 'agent-missing');
  } finally {
    cleanup();
  }
});

test("each agent's own default model is read from its settings, in its order of precedence", () => {
  const { dir, env, cleanup } = home();
  const root = path.join(dir, 'repo');
  try {
    assert.equal(agentDefault('codex', { env, root }).model, null, 'no settings: the agent picks its built-in default');

    write(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-5.1-codex"   # mine\nmodel_reasoning_effort = \'high\'\n[profiles.fast]\nmodel = "gpt-5.1-codex-mini"\n');
    assert.deepEqual(agentDefault('codex', { env, root }), {
      model: 'gpt-5.1-codex', effort: 'high', modelFrom: path.join(dir, '.codex', 'config.toml'), effortFrom: path.join(dir, '.codex', 'config.toml'),
    });
    write(path.join(root, '.codex', 'config.toml'), 'model = "gpt-5.2"\n');
    const codex = agentDefault('codex', { env, root });
    assert.equal(codex.model, 'gpt-5.2', 'the project file comes first');
    assert.equal(codex.effort, 'high', 'settings the project file leaves out come from the user file');
    assert.equal(agentDefault('codex', { env: { ...env, CODEX_HOME: path.join(dir, 'elsewhere') } }).model, null);

    write(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', effortLevel: 'medium' }));
    assert.equal(agentDefault('claude', { env, root }).model, 'sonnet');
    write(path.join(root, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    write(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({ model: 'haiku' }));
    assert.deepEqual(
      { ...agentDefault('claude', { env, root }) },
      { model: 'haiku', effort: 'medium', modelFrom: path.join(root, '.claude', 'settings.local.json'), effortFrom: path.join(dir, '.claude', 'settings.json') },
    );
    assert.equal(agentDefault('claude', { env: { ...env, ANTHROPIC_MODEL: 'opus[1m]' }, root }).model, 'opus[1m]');
    write(path.join(root, '.claude', 'settings.local.json'), '{ broken');
    assert.match(agentDefault('claude', { env, root }).problems[0], /not valid JSON/);

    write(path.join(dir, '.dsh', 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n');
    assert.deepEqual(
      { ...agentDefault('dsh', { env }) },
      { model: 'deepseek-v4-flash', effort: null, provider: 'deepseek-official', modelFrom: path.join(dir, '.dsh', 'settings.yaml'), effortFrom: null },
    );
    write(path.join(dir, 'dsh-home', 'settings.yaml'), 'agent-default-model: {provider: x, model: y}\n');
    const unreadable = agentDefault('dsh', { env: { ...env, DSH_HOME: path.join(dir, 'dsh-home') } });
    assert.equal(unreadable.model, null, 'a file outside the YAML subset is not guessed at');
    assert.match(unreadable.problems[0], /could not be read: line 1/);
  } finally {
    cleanup();
  }
});

test('TOML top-level keys stop at the first table', () => {
  assert.deepEqual(tomlTopLevel('a = "x \\"q\\""\nb = 3 # n\n\n[t]\nc = 1\n'), { a: 'x "q"', b: '3' });
});

test('the claude list is the documented aliases, plus the API list when a key is set', async () => {
  assert.deepEqual((await listClaudeModels({ env: {} })).models.map(m => m.id), [...CLAUDE_ALIASES]);

  const key = `test-${crypto.randomUUID()}`;
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'], auth: req.headers.authorization });
    const page = req.url.includes('after_id=m2')
      ? { data: [{ id: 'claude-model-3', display_name: 'Model 3' }], has_more: false, last_id: 'm3' }
      : { data: [{ id: 'claude-model-1' }, { id: 'claude-model-2' }], has_more: true, last_id: 'm2' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(page));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` };
    const listed = await listClaudeModels({ env });
    assert.equal(listed.source, 'aliases+api');
    assert.deepEqual(listed.models.filter(m => m.kind === 'api').map(m => m.id), ['claude-model-1', 'claude-model-2', 'claude-model-3']);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].key, key, 'the key is sent to the API');
    assert.ok(!JSON.stringify(listed).includes(key), 'and never returned');

    const down = await listClaudeModels({ env: { ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
    assert.equal(down.source, 'aliases');
    assert.match(down.apiError, /could not be read/);
    assert.ok(!JSON.stringify(down).includes(key));
  } finally {
    server.close();
  }
});

test('fetched lists are cached for a day; refresh fetches again; fetch: false starts nothing', async () => {
  const { dir, env, cleanup } = home();
  try {
    const cacheFile = modelsCachePath(env);
    assert.equal(cacheFile, path.join(dir, '.config', 'agenthub-relay', 'models-cache.json'));
    const none = await catalogFor('codex', { env, config: config(), fetch: false });
    assert.equal(none.error.code, 'not-fetched');

    const first = await catalogFor('codex', { env, config: config() });
    assert.equal(first.source, 'codex app-server');
    assert.equal(first.models.length, 3);
    assert.ok(fs.existsSync(cacheFile));

    const broken = { ...env, FAKE_APP_SERVER: 'error' };
    const cached = await catalogFor('codex', { env: broken, config: config() });
    assert.equal(cached.cached, true, 'a fresh cache is used');
    assert.equal(cached.models.length, 3);
    const later = await catalogFor('codex', { env: broken, config: config(), now: Date.now() + 25 * 60 * 60_000 });
    assert.equal(later.error.code, 'model-list-failed', 'an old cache is not');
    const refreshed = await catalogFor('codex', { env: broken, config: config(), refresh: true });
    assert.equal(refreshed.error.code, 'model-list-failed');
    assert.equal((await catalogFor('codex', { env, config: config(), fetch: false })).models.length, 3, 'a failed fetch leaves the cache as it was');

    write(path.join(dir, '.dsh', 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    opper:\n      models:\n        - id: deepseek-v4-flash\n');
    const dsh = await catalogFor('dsh', { env });
    assert.deepEqual(dsh.models, [{ id: 'deepseek-v4-flash', provider: 'opper' }]);
    assert.equal(dsh.choosesModel, false);
    assert.equal((await catalogFor('acp', { env })).reserved, true);
    await assert.rejects(catalogFor('cursor', { env }), err => err.code === 'unknown-agent');
  } finally {
    cleanup();
  }
});

test('reading the catalog never changes an agent settings file', async () => {
  const { dir, env, cleanup } = home();
  try {
    const files = [
      [path.join(dir, '.codex', 'config.toml'), 'model = "gpt-5.1-codex"\n'],
      [path.join(dir, '.claude', 'settings.json'), '{"model":"opus"}'],
      [path.join(dir, '.dsh', 'settings.yaml'), 'agent-default-model:\n  model: deepseek-v4-flash\n'],
    ];
    for (const [file, text] of files) write(file, text);
    const before = files.map(([file]) => fs.statSync(file).mtimeMs);
    await sleep(20);
    for (const agent of ['codex', 'claude', 'dsh']) await catalogFor(agent, { env, config: config() });
    assert.deepEqual(files.map(([file]) => fs.statSync(file).mtimeMs), before);
    assert.deepEqual(files.map(([file]) => fs.readFileSync(file, 'utf8')), files.map(([, text]) => text));
  } finally {
    cleanup();
  }
});

test('checking a route: codex against its list, claude by form, dsh never takes a model', () => {
  const codex = {
    default: { model: 'gpt-5.1-codex' },
    models: [
      { id: 'gpt-5.1-codex', model: 'gpt-5.1-codex', isDefault: true, efforts: ['low', 'medium', 'high'] },
      { id: 'gpt-5.2', model: 'gpt-5.2', efforts: ['low', 'xhigh'] },
    ],
  };
  const status = (route, catalog) => checkRoute(route, catalog).status;
  assert.equal(status({ executor: 'codex', model: 'gpt-5.2', effort: 'xhigh' }, codex), 'verified');
  const unknown = checkRoute({ executor: 'codex', model: 'gpt-5' }, codex);
  assert.equal(unknown.code, 'model-unknown');
  assert.deepEqual(unknown.suggestions, ['gpt-5.1-codex', 'gpt-5.2']);
  assert.equal(checkRoute({ executor: 'codex', model: 'gpt-5.1-codex', effort: 'xhigh' }, codex).code, 'effort-unsupported');
  assert.equal(checkRoute({ executor: 'codex', effort: 'xhigh' }, codex).code, 'effort-unsupported', "an effort alone is checked against codex's default model");
  assert.equal(status({ executor: 'codex' }, codex), 'agent-default');
  assert.equal(checkRoute({ executor: 'codex', model: 'gpt-5.2' }, { error: { message: 'not on PATH' }, models: [] }).code, 'model-unverified');

  assert.equal(status({ executor: 'claude', model: 'opus[1m]', effort: 'max' }, {}), 'verified');
  assert.equal(status({ executor: 'claude', model: 'claude-opus-5-5' }, {}), 'format-only');
  assert.equal(checkRoute({ executor: 'claude', effort: 'extreme' }, {}).code, 'effort-unsupported');
  assert.equal(checkRoute({ executor: 'claude', model: 'two words' }, {}).code, 'invalid-value');

  const dsh = checkRoute({ executor: 'dsh', model: 'deepseek-v4-pro' }, { default: { model: 'deepseek-v4-flash', modelFrom: '~/.dsh/settings.yaml' } });
  assert.equal(dsh.code, 'model-unsupported');
  assert.match(dsh.reason, /its default model is deepseek-v4-flash \(from ~\/\.dsh\/settings\.yaml\)/);
  assert.equal(status({ executor: 'dsh' }, {}), 'agent-default');
  assert.equal(checkRoute({ executor: 'acp' }, {}).code, 'reserved-executor');
});

test('checking an Antigravity route: Gemini slugs against agy models, by form when the list is missing', () => {
  const agy = { models: parseAgyModels('gemini-4-argon-high   Gemini 4 Argon (High)\ngemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\n') };
  const status = (route, catalog) => checkRoute(route, catalog).status;
  assert.equal(status({ executor: 'agy' }, agy), 'agent-default');
  assert.equal(status({ executor: 'agy', model: 'gemini-4-argon-high', effort: 'high' }, agy), 'verified');
  const cliName = checkRoute({ executor: 'agy', model: 'gemini-4-argon' }, agy);
  assert.equal(cliName.code, 'model-unknown', 'a bare Gemini model name is not an Antigravity slug');
  assert.deepEqual(cliName.suggestions, ['gemini-4-argon-high']);
  assert.equal(status({ executor: 'agy', model: 'gemini-4-argon-high' }, { error: { message: 'not on PATH' }, models: [] }), 'format-only');
  assert.equal(checkRoute({ executor: 'agy', model: 'two words' }, agy).code, 'invalid-value');
});

test('agy models: slugs and display names from `agy models`; a failing or missing agy gives a coded error', async () => {
  assert.deepEqual(parseAgyModels('gemini-4-argon-high       Gemini 4 Argon (High)\r\n\r\ngemini-3.1-pro-high\n...\n'), [
    { id: 'gemini-4-argon-high', model: 'gemini-4-argon-high', displayName: 'Gemini 4 Argon (High)' },
    { id: 'gemini-3.1-pro-high', model: 'gemini-3.1-pro-high' },
  ]);
  // agy 1.5.2 separates the slug and the name with one tab.
  assert.deepEqual(parseAgyModels('gemini-4-argon-medium\tGemini 4 Argon (Medium)\r\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\r\n').map(m => [m.id, m.displayName]), [
    ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)'],
    ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ]);
  const models = await listAgyModels({ command: fakeAgent(), env: process.env });
  assert.deepEqual(models.map(m => m.id), ['gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-3.8-flash-medium']);
  await assert.rejects(listAgyModels({ command: fakeAgent(), env: { ...process.env, FAKE_AGY_MODELS: 'fail' } }), err => err.code === 'model-list-failed' && /authentication required/.test(err.message));
  await assert.rejects(listAgyModels({ command: fakeAgent(), env: { ...process.env, FAKE_AGY_MODELS: '[]' } }), err => err.code === 'model-list-failed');
  await assert.rejects(listAgyModels({ command: 'agenthub-no-such-agy', env: process.env }), err => err.code === 'agent-missing');

  const { env, cleanup } = home();
  try {
    const catalog = await catalogFor('agy', { env, config: { executors: { agy: { command: fakeAgent() } } } });
    assert.equal(catalog.source, 'agy models');
    assert.equal(catalog.models[0].id, 'gemini-4-argon-high');
    assert.equal(catalog.default.model, null, 'Antigravity keeps its own default');
    const cached = await catalogFor('agy', { env, config: { executors: { agy: { command: fakeAgent() } } }, fetch: false });
    assert.equal(cached.cached, true);
  } finally {
    cleanup();
  }
});
