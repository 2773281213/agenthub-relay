import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { adapterFor, buildPrompt, childEnv, describeExecutors, findOnPath, MAX_ARGV_PROMPT_BYTES, selectionArgs } from '../src/executors.mjs';
import { tempDir } from './helpers.mjs';

const config = loadConfig({ env: {} });
const files = { final: '/tmp/job/final.md' };

function job(extra = {}) {
  return {
    id: 'j20261029-000000-abcdef',
    tier: 'deep',
    write: true,
    title: 'Refactor the parser',
    task: 'Split parse() into tokenize() and build().',
    scope: ['src/parser'],
    checks: ['npm test', 'npm run lint -- --max-warnings 0'],
    base: { commit: '0123456789abcdef0123456789abcdef01234567' },
    ...extra,
  };
}

test('codex runs `codex exec --json` with the sandbox matching the tier and the task on stdin', () => {
  const codex = adapterFor('codex');
  const write = codex.invocation(job(), config.executors.codex, files, 'PROMPT');
  assert.deepEqual(write.argv, ['codex', 'exec', '--json', '--sandbox', 'workspace-write', '-o', files.final, '-']);
  assert.equal(write.stdin, 'PROMPT');
  const review = codex.invocation(job({ tier: 'review', write: false }), config.executors.codex, files, 'P');
  assert.equal(review.argv[review.argv.indexOf('--sandbox') + 1], 'read-only');
});

// Found in the real run on Windows: Claude Code 2.1.220 has no --permission-prompts
// and calls "manual" "default"; -p denies whatever would prompt in every release.
test('claude runs headless, edits accepted only for write tiers, checks allowed, with flags every release knows', () => {
  const claude = adapterFor('claude');
  const write = claude.invocation(job(), config.executors.claude, files, 'PROMPT');
  assert.deepEqual(write.argv, [
    'claude', '-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(npm test)', 'Bash(npm run lint -- --max-warnings 0)',
  ]);
  assert.equal(write.stdin, 'PROMPT');
  const review = claude.invocation(job({ tier: 'review', write: false, checks: [] }), { ...config.executors.claude, bare: true, extraArgs: ['--model', 'opus'] }, files, 'P');
  assert.deepEqual(review.argv, [
    'claude', '-p', '--output-format', 'json', '--bare', '--model', 'opus',
  ]);
});

test('dsh takes the task as its positional argument and refuses one that is too long', () => {
  const dsh = adapterFor('dsh');
  const run = dsh.invocation(job({ tier: 'light' }), config.executors.dsh, files, 'PROMPT');
  assert.deepEqual(run.argv, ['dsh', '--profile', 'headless', 'PROMPT']);
  assert.equal(run.stdin, null);
  assert.throws(
    () => dsh.invocation(job(), config.executors.dsh, files, 'x'.repeat(MAX_ARGV_PROMPT_BYTES + 1)),
    err => err.code === 'prompt-too-long',
  );
});

test('agy runs the Antigravity CLI with the task as one stream-json user event, edits accepted only for write tiers', () => {
  const agy = adapterFor('agy');
  assert.equal(agy.label, 'Antigravity CLI');
  const write = agy.invocation(job(), config.executors.agy, files, 'PROMPT "quoted"\nline two');
  assert.deepEqual(write.argv, [
    'agy', '--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'accept-edits',
    '--settings', JSON.stringify({ permissions: { allow: ['command(npm test)', 'command(npm run lint -- --max-warnings 0)'] } }),
  ]);
  assert.ok(write.stdin.endsWith('\n'), 'one line, so the CLI can read the event');
  assert.deepEqual(JSON.parse(write.stdin), { event: 'user', message: { content: 'PROMPT "quoted"\nline two' } });
  assert.equal(write.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true', 'the CLI does not update itself mid-job');
  assert.ok(!write.argv.includes('-p'), 'a -p prompt is dropped in streaming mode');
  const unchecked = agy.invocation(job({ checks: [] }), config.executors.agy, files, 'P');
  assert.ok(!unchecked.argv.includes('--settings'), 'no rules without checks');

  // agy writes inside its workspace even in its default mode: a review denies it.
  const review = agy.invocation(job({ tier: 'review', write: false, checks: [] }), config.executors.agy, files, 'P');
  assert.deepEqual(review.argv, [
    'agy', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--settings', '{"permissions":{"deny":["write_file(*)","command(*)"]}}',
  ]);
  assert.ok(!review.argv.includes('--dangerously-skip-permissions'));
  assert.ok(!review.argv.includes('--mode'));

  const long = agy.invocation(job(), config.executors.agy, files, 'x'.repeat(MAX_ARGV_PROMPT_BYTES + 1));
  assert.ok(!long.argv.some(arg => arg.length > 1000), 'a long task stays off the command line');
});

test('agy output: the result event gives the answer, conversation and usage; errors keep their status', () => {
  const agy = adapterFor('agy');
  const events = result => [
    JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: { cwd: '/w', permission_mode: 'accept-edits' } }),
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: 'partial' } }),
    ...(result ? [JSON.stringify({ event: 'result', result })] : []),
  ].join('\n');

  const done = agy.parse({ exitCode: 0, stdout: events({ conversation_id: 'conv-1', status: 'SUCCESS', response: 'Changed parse().', usage: { input_tokens: 9, output_tokens: 2 } }), stderr: '' });
  assert.deepEqual(done, { ok: true, summary: 'Changed parse().', sessionId: 'conv-1', usage: { input_tokens: 9, output_tokens: 2 }, error: undefined });

  const badModel = agy.parse({ exitCode: 1, stdout: events({ conversation_id: '', status: 'ERROR', response: '', error: 'invalid model selection (gemini-4-argon)' }), stderr: '' });
  assert.equal(badModel.ok, false);
  assert.equal(badModel.sessionId, 'conv-1');
  assert.equal(badModel.error, 'ERROR: invalid model selection (gemini-4-argon)');

  const canceled = agy.parse({ exitCode: 0, stdout: events({ conversation_id: 'conv-1', status: 'CANCELED', response: '' }), stderr: '' });
  assert.equal(canceled.ok, false, 'exit 0 is not enough: the status must be SUCCESS');
  assert.match(canceled.error, /CANCELED/);

  // Seen with agy 1.5.2: a denied command ends the turn with an empty response.
  const deniedEarly = agy.parse({ exitCode: 0, stdout: events({ conversation_id: 'conv-1', status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }), stderr: '' });
  assert.equal(deniedEarly.ok, true, 'the edits it made are still the job');
  assert.equal(deniedEarly.summary, 'partial\n\nAntigravity denied: command RunCommand.', 'the streamed text stands in for the missing response');
  const deniedSilent = agy.parse({ exitCode: 0, stdout: [JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } })].join('\n'), stderr: '' });
  assert.equal(deniedSilent.summary, 'Antigravity denied: command RunCommand. It ended its turn without a final message.');
  const deniedAfter = agy.parse({ exitCode: 0, stdout: events({ status: 'SUCCESS', response: 'Done.\n', denied_actions: [{ action: 'write_file' }] }), stderr: '' });
  assert.equal(deniedAfter.summary, 'Done.\n\nAntigravity denied: write_file.');

  const noResult = agy.parse({ exitCode: 1, stdout: '', stderr: 'Error: authentication required\n' });
  assert.equal(noResult.ok, false);
  assert.equal(noResult.error, 'Error: authentication required');
  assert.match(agy.parse({ exitCode: 0, stdout: events(undefined), stderr: '' }).error, /without a result event/);
});

test('reserved executors fail closed', () => {
  assert.throws(() => adapterFor('acp'), err => err.code === 'reserved-executor');
  assert.throws(() => adapterFor('aider'), err => err.code === 'unknown-executor');
});

test('codex output: JSONL events plus the -o final message', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"from the stream"}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":7}}',
  ].join('\n');
  const codex = adapterFor('codex');
  const ok = codex.parse({ exitCode: 0, stdout, stderr: '', finalText: 'final from -o\n' });
  assert.deepEqual(ok, { ok: true, summary: 'final from -o', sessionId: 't-1', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7 }, error: undefined });
  assert.equal(codex.parse({ exitCode: 0, stdout, stderr: '', finalText: '' }).summary, 'from the stream');
  const failed = codex.parse({ exitCode: 1, stdout: '{"type":"turn.failed","error":{"message":"quota"}}', stderr: '' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'quota');
});

test('claude output: the JSON result, its cost and errors', () => {
  const claude = adapterFor('claude');
  const ok = claude.parse({
    exitCode: 0,
    stdout: '{"type":"result","subtype":"success","is_error":false,"result":"All done","session_id":"s-1","total_cost_usd":0.25,"usage":{"input_tokens":5}}',
    stderr: '',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.summary, 'All done');
  assert.equal(ok.costUsd, 0.25);
  assert.equal(ok.sessionId, 's-1');
  const err = claude.parse({ exitCode: 1, stdout: '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"ran out"}', stderr: '' });
  assert.equal(err.ok, false);
  assert.match(err.error, /error_max_turns/);
  const crash = claude.parse({ exitCode: 1, stdout: '', stderr: 'Invalid API key' });
  assert.equal(crash.error, 'Invalid API key');
});

test('dsh output: stdout is the answer, the exit code is the verdict', () => {
  const dsh = adapterFor('dsh');
  assert.deepEqual(dsh.parse({ exitCode: 0, stdout: 'answer\n', stderr: '' }), { ok: true, summary: 'answer', error: undefined });
  assert.equal(dsh.parse({ exitCode: 1, stdout: '', stderr: 'error: model unavailable\n' }).error, 'error: model unavailable');
});

test('executors get an allow-listed environment; credentials pass only by name', () => {
  const source = { PATH: '/bin', HOME: '/home/u', SECRET_TOKEN: 'abc', OPENAI_API_KEY: 'sk-x', RANDOM_VAR: '1' };
  const plain = childEnv(source, config.executors.codex, 'j1');
  assert.deepEqual(plain.env, { PATH: '/bin', HOME: '/home/u', AGENTHUB_RELAY_ROLE: 'executor', AGENTHUB_RELAY_JOB: 'j1' });
  assert.deepEqual(plain.passed, []);
  const named = childEnv(source, { ...config.executors.codex, passEnv: ['OPENAI_API_KEY', 'MISSING'] }, 'j1');
  assert.equal(named.env.OPENAI_API_KEY, 'sk-x');
  assert.equal(named.env.SECRET_TOKEN, undefined);
  assert.deepEqual(named.passed, ['OPENAI_API_KEY']);
});

test('the executor prompt states scope, checks and the rules for each tier', () => {
  const write = buildPrompt(job());
  assert.match(write, /scope: src\/parser/);
  assert.match(write, /`npm test`/);
  assert.match(write, /Do not commit/);
  assert.match(write, /from commit 0123456789ab/);
  const review = buildPrompt(job({ tier: 'review', write: false, checks: [], scope: ['.'] }));
  assert.match(review, /read-only review/);
  assert.doesNotMatch(review, /Change only files/);
});

test('availability is looked up on PATH; reserved executors are listed with their reason', () => {
  const nodeDir = path.dirname(process.execPath);
  assert.equal(findOnPath('node', nodeDir), path.join(nodeDir, 'node'));
  assert.equal(findOnPath(process.execPath, ''), process.execPath);
  assert.equal(findOnPath('definitely-not-a-command-xyz', process.env.PATH), null);
  const { dir, cleanup } = tempDir();
  try {
    const listed = describeExecutors(config, { PATH: dir });
    assert.deepEqual(listed.map(e => e.id), ['codex', 'claude', 'dsh', 'agy', 'acp']);
    assert.ok(listed.filter(e => !e.reserved).every(e => e.available === false));
    assert.deepEqual(listed.find(e => e.id === 'codex').tiers, ['deep']);
    assert.match(listed.find(e => e.id === 'acp').reason, /reserved/);
    assert.equal(listed.find(e => e.id === 'agy').reserved, undefined, 'Antigravity is a live executor');
    assert.equal(listed.find(e => e.id === 'agy').label, 'Antigravity CLI');

    const fakeCodex = path.join(dir, 'codex');
    fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const found = describeExecutors(config, { PATH: dir }).find(e => e.id === 'codex');
    assert.equal(found.available, true);
    assert.equal(found.path, fakeCodex);
  } finally {
    cleanup();
  }
});

test('a job model and effort go on each command line through the documented flags', () => {
  const chosen = job({ model: 'gpt-5.1-codex', effort: 'high' });
  const codex = adapterFor('codex').invocation(chosen, config.executors.codex, files, 'P').argv;
  assert.deepEqual(codex, [
    'codex', 'exec', '--json', '--sandbox', 'workspace-write', '-o', files.final,
    '-m', 'gpt-5.1-codex', '-c', 'model_reasoning_effort=high', '-',
  ]);

  const claude = adapterFor('claude').invocation(job({ model: 'opus', effort: 'max' }), config.executors.claude, files, 'P').argv;
  assert.deepEqual(claude.slice(claude.indexOf('--model'), claude.indexOf('--model') + 4), ['--model', 'opus', '--effort', 'max']);
  assert.ok(claude.indexOf('--model') < claude.indexOf('--allowedTools'), 'flags precede the variadic --allowedTools');

  const plain = adapterFor('claude').invocation(job(), config.executors.claude, files, 'P').argv;
  assert.ok(!plain.includes('--model') && !plain.includes('--effort'), 'no flags without a chosen model');

  const dshCfg = { ...config.executors.dsh, modelArgs: ['--model={model}'] };
  const dsh = adapterFor('dsh').invocation(job({ tier: 'light', model: 'deepseek-flash' }), dshCfg, files, 'PROMPT').argv;
  assert.deepEqual(dsh.slice(-2), ['--model=deepseek-flash', 'PROMPT']);
  assert.deepEqual(selectionArgs({}, config.executors.dsh), []);

  const agy = adapterFor('agy').invocation(job({ tier: 'review', write: false, model: 'gemini-4-argon-high', effort: 'high' }), config.executors.agy, files, 'P').argv;
  assert.deepEqual(agy.slice(-4), ['--model', 'gemini-4-argon-high', '--effort', 'high']);
});

test('relay_agents reports default models and which executors can take one', () => {
  const described = describeExecutors(config, { PATH: '' });
  const byId = Object.fromEntries(described.map(entry => [entry.id, entry]));
  assert.equal(byId.codex.choosesModel, true);
  assert.equal(byId.claude.choosesEffort, true);
  assert.equal(byId.dsh.choosesModel, false);
  assert.equal(byId.agy.choosesModel, true);
  assert.equal(byId.agy.choosesEffort, true);
});

test('executors on Windows keep the variables Windows programs need, and nothing else unnamed', () => {
  const source = { SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', SECRET_TOKEN: 'x' };
  const { env } = childEnv(source, { passEnv: [] }, 'j20261029-000000-abcdef');
  assert.equal(env.SYSTEMROOT, 'C:\\Windows');
  assert.equal(env.USERPROFILE, 'C:\\Users\\me', 'codex, claude and dsh keep their sign-in under the profile');
  assert.equal(env.APPDATA, source.APPDATA);
  assert.equal(env.SECRET_TOKEN, undefined);
});
