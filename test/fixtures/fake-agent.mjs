#!/usr/bin/env node
// A stand-in for the executor CLIs in tests. It recognizes which interface it
// was called through and answers the way that CLI documents:
//   codex exec --json ... -        JSONL events on stdout, final message to -o
//   claude -p --output-format json one JSON result on stdout
//   dsh --profile headless "task"  final answer on stdout, exit 0 or 1
// What it does comes from a line `FAKE {...json...}` in the task text.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = args[0] === 'exec' ? 'codex' : args.includes('-p') ? 'claude' : args[0] === '--profile' ? 'dsh' : 'other';

if (args[0] === '--version') {
  process.stdout.write('fake-agent 0.0.0\n');
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const prompt = mode === 'dsh' ? args[args.length - 1] : await readStdin();
const match = /^FAKE (\{.*\})$/m.exec(prompt);
const plan = match ? JSON.parse(match[1]) : {};
const message = plan.message ?? `fake ${mode} finished`;

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
