// The YAML subset the model catalog reads agent settings with.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseYaml } from '../src/yaml-lite.mjs';

test('reads a DeepSeek Harness settings file', () => {
  const text = [
    '# written by the dsh web UI',
    'agent-default-model:',
    '  provider: opper',
    '  model: anthropic/claude-sonnet-4-6   # the default for new sessions',
    '  reasoningEffort: "high"',
    '',
    'llm-pi-ai:',
    '  providers:',
    '    opper:',
    '      apiKeyEnv: OPPER_API_KEY',
    '      api: openai-completions',
    '      baseURL: https://api.opper.ai/v3/compat',
    '      models:',
    '        - id: anthropic/claude-sonnet-4-6',
    '        - id: tensorx/deepseek/deepseek-v4-flash',
    '          name: \'DeepSeek V4 Flash (it\'\'s fast)\'',
  ].join('\n');
  assert.deepEqual(parseYaml(text), {
    'agent-default-model': { provider: 'opper', model: 'anthropic/claude-sonnet-4-6', reasoningEffort: 'high' },
    'llm-pi-ai': {
      providers: {
        opper: {
          apiKeyEnv: 'OPPER_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://api.opper.ai/v3/compat',
          models: [
            { id: 'anthropic/claude-sonnet-4-6' },
            { id: 'tensorx/deepseek/deepseek-v4-flash', name: "DeepSeek V4 Flash (it's fast)" },
          ],
        },
      },
    },
  });
});

test('scalars, sequences at the key indentation, empty collections and a document marker', () => {
  const text = ['---', 'count: 3', 'ratio: 0.5', 'on: true', 'off: false', 'none: ~', 'path: C:\\Users\\me', 'empty: []', 'list:', '- a', '- "b # not a comment"', '- - nested', 'quoted key: "x\\ty"'].join('\r\n');
  assert.deepEqual(parseYaml(text), {
    count: 3,
    ratio: 0.5,
    on: true,
    off: false,
    none: null,
    path: 'C:\\Users\\me',
    empty: [],
    list: ['a', 'b # not a comment', ['nested']],
    'quoted key': 'x\ty',
  });
  assert.equal(parseYaml(''), null);
  assert.equal(parseYaml('# only a comment\n'), null);
});

test('anything outside the subset is refused with its line, never guessed', () => {
  const refused = [
    ['a: {b: 1}', 1],
    ['a: [1, 2]', 1],
    ['a: &anchor 1\nb: *anchor', 1],
    ['a: |\n  text', 1],
    ['a: !!str 1', 1],
    ['a: 1\n---\nb: 2', 2],
    ['a:\n\tb: 1', 2],
    ['a: 1\n  b: 2', 2],
    ['a: 1\na: 2', 2],
    ['a: "open', 1],
    ['just text\nmore text', 1],
  ];
  for (const [text, line] of refused) {
    assert.throws(() => parseYaml(text), err => err.code === 'yaml-unsupported' && err.line === line, JSON.stringify(text));
  }
});
