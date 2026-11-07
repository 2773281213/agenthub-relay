#!/usr/bin/env node
// A stand-in for the executor CLIs in tests. It recognizes which interface it
// was called through and answers the way that CLI documents:
//   codex exec --json ... -        JSONL events on stdout, final message to -o
//   claude -p --output-format json one JSON result on stdout
//   dsh --profile headless "task"  final answer on stdout, exit 0 or 1
//   agy --input-format stream-json --output-format stream-json
//                                  one user event on stdin, NDJSON events out
//   agy models                     model slugs and display names
// What it does comes from a line `FAKE {...json...}` in the task text.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = args[0] === 'exec' ? 'codex'
  : args.includes('--input-format') ? 'agy'
  : args.includes('-p') ? 'claude'
  : args[0] === '--profile' ? 'dsh'
  : 'other';

if (args[0] === '--version') {
  process.stdout.write('fake-agent 0.0.0\n');
  process.exit(0);
}

if (args[0] === 'models') {
  // `agy models`. FAKE_AGY_MODELS=fail exits non-zero; otherwise it is the
  // list to print, one "slug   Display Name" per line.
  if (process.env.FAKE_AGY_MODELS === 'fail') {
    process.stderr.write('Error: authentication required\n');
    process.exit(1);
  }
  const lines = process.env.FAKE_AGY_MODELS
    ? JSON.parse(process.env.FAKE_AGY_MODELS)
    : ['gemini-4-argon-high       Gemini 4 Argon (High)', 'gemini-4-argon-medium     Gemini 4 Argon (Medium)', 'gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)'];
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

if (args[0] === 'app-server') {
  // `codex app-server`: JSON-RPC over stdio lines. FAKE_APP_SERVER selects
  // misbehaviour (hang, error, exit); FAKE_CODEX_MODELS is the model list,
  // served two to a page; FAKE_APP_SERVER_PID records this process's pid.
  if (process.env.FAKE_APP_SERVER_PID) fs.writeFileSync(process.env.FAKE_APP_SERVER_PID, String(process.pid));
  const behaviour = process.env.FAKE_APP_SERVER ?? 'ok';
  if (behaviour === 'exit') {
    process.stderr.write('fake app-server: not signed in\n');
    process.exit(3);
  }
  const models = process.env.FAKE_CODEX_MODELS
    ? JSON.parse(process.env.FAKE_CODEX_MODELS)
    : [
        { id: 'gpt-5.1-codex', model: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex', isDefault: true, hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium' },
        { id: 'gpt-5.1-codex-mini', model: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', isDefault: false, hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'low' },
        { id: 'gpt-5.2', model: 'gpt-5.2', displayName: 'GPT-5.2', isDefault: false, hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] },
      ];
  let initialized = false;
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (behaviour === 'hang') continue;
      const reply = body => process.stdout.write(`${JSON.stringify({ id: message.id, ...body })}\n`);
      if (message.method === 'initialize') reply({ result: { userAgent: 'fake-codex/0.0.0' } });
      else if (message.method === 'initialized') initialized = true;
      else if (message.method === 'model/list') {
        if (!initialized) reply({ error: { code: -32002, message: 'Not initialized' } });
        else if (behaviour === 'error') reply({ error: { code: -32603, message: 'fake model/list failure' } });
        else {
          const start = message.params?.cursor ? Number(message.params.cursor) : 0;
          const data = models.slice(start, start + 2);
          const next = start + 2 < models.length ? String(start + 2) : null;
          reply({ result: { data, nextCursor: next } });
        }
      } else if (message.id !== undefined) reply({ error: { code: -32601, message: `unknown method ${message.method}` } });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  await new Promise(() => {});
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function agyPrompt(text) {
  // The first `user` event; its content is a string or a list of text blocks.
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.event !== 'user') continue;
    const content = event.message?.content;
    return Array.isArray(content) ? content.map(block => block.text).join('') : content;
  }
  return '';
}

const prompt = mode === 'dsh' ? args[args.length - 1] : mode === 'agy' ? agyPrompt(await readStdin()) : await readStdin();
const match = /^FAKE (\{.*\})$/m.exec(prompt);
const plan = match ? JSON.parse(match[1]) : {};
const echoed = plan.echoEnv ? ` ${process.env[plan.echoEnv] ?? ''}` : '';
const message = `${plan.message ?? `fake ${mode} finished`}${echoed}`;
if (plan.echoEnv) {
  // An executor that leaks what it was given, on both streams.
  process.stderr.write(`debug:${echoed}\n`);
}

if (plan.record) {
  const names = plan.envNames ?? [];
  fs.writeFileSync(plan.record, JSON.stringify({
    mode,
    args,
    cwd: process.cwd(),
    prompt,
    role: process.env.AGENTHUB_RELAY_ROLE ?? null,
    job: process.env.AGENTHUB_RELAY_JOB ?? null,
    present: Object.fromEntries(names.map(name => [name, process.env[name] !== undefined])),
  }));
}

for (const [file, content] of Object.entries(plan.write ?? {})) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content);
}
for (const [file, name] of Object.entries(plan.writeEnv ?? {})) {
  // An executor that writes what it was given into the repository.
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `KEY=${process.env[name] ?? ''}\n`);
}
for (const file of plan.remove ?? []) fs.rmSync(file, { force: true });

if (plan.spawnChild) {
  // A grandchild that outlives us unless the whole process group is killed.
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  fs.writeFileSync(plan.spawnChild, String(child.pid));
}
if (plan.sleepMs) await new Promise(resolve => setTimeout(resolve, plan.sleepMs));

const failed = plan.fail === true;
if (mode === 'codex') {
  const out = [];
  const emit = event => out.push(JSON.stringify(event));
  emit({ type: 'thread.started', thread_id: 'fake-thread' });
  emit({ type: 'turn.started' });
  if (failed) {
    emit({ type: 'turn.failed', error: { message: 'fake codex failure' } });
  } else {
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: message } });
    emit({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 3 } });
  }
  process.stdout.write(`${out.join('\n')}\n`);
  const final = args[args.indexOf('-o') + 1];
  if (!failed && final) fs.writeFileSync(final, `${message}\n`);
  process.exit(plan.exitCode ?? (failed ? 1 : 0));
} else if (mode === 'claude') {
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    subtype: failed ? 'error_during_execution' : 'success',
    is_error: failed,
    result: failed ? 'fake claude failure' : message,
    session_id: 'fake-session',
    total_cost_usd: 0.0123,
    num_turns: 1,
    usage: { input_tokens: 20, output_tokens: 4 },
  })}\n`);
  process.exit(plan.exitCode ?? (failed ? 1 : 0));
} else if (mode === 'agy') {
  const id = 'fake-conversation';
  const out = [
    { event: 'init', conversation_id: id, init: { cwd: process.cwd(), permission_mode: args.includes('accept-edits') ? 'accept-edits' : 'request-review' } },
    { event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: failed ? '' : message } },
    { event: 'result', result: {
      conversation_id: id,
      status: failed ? 'ERROR' : 'SUCCESS',
      response: failed ? '' : message,
      ...(failed ? { error: 'fake agy failure' } : {}),
      duration_seconds: 1,
      num_turns: 1,
      usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
    } },
  ];
  process.stdout.write(`${out.map(event => JSON.stringify(event)).join('\n')}\n`);
  process.exit(plan.exitCode ?? (failed ? 1 : 0));
} else if (mode === 'dsh') {
  if (failed) {
    process.stderr.write('error: fake dsh failure\n');
    process.exit(plan.exitCode ?? 1);
  }
  process.stdout.write(`${message}\n`);
  process.exit(plan.exitCode ?? 0);
} else {
  process.stderr.write(`fake-agent: unrecognized invocation ${JSON.stringify(args)}\n`);
  process.exit(2);
}
