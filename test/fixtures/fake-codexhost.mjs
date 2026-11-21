#!/usr/bin/env node
// A stand-in for the codexhost CLI in tests: a Host whose Threads live in
// $CODEXHOST_DATA_DIR/fake-host.json. It answers the documented commands with
// their JSON shapes (errors as {"error":{code,message}} on stderr, exit 1):
//   delegate start --harness <h> --cwd <dir> --task-file - [--task-name] [--model] [--thinking]
//   thread send <thread> --message-file - [--interrupt]
//   thread wait <thread> --timeout-ms <n>
//   thread cancel <thread>
// What a turn does comes from a line `FAKE {...json...}` in its task or message:
//   write: { path: content }  files written in the Thread's cwd
//   message: text             the turn's final reply
//   ask: text                 the turn stops on a question
//   delayMs: n                the turn runs this long before it completes
//   fail: true                the turn ends failed
// Every call is recorded in the state file (args and which CODEXHOST_* and
// thread variables it saw), for the tests to read.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dataDir = process.env.CODEXHOST_DATA_DIR;
if (!dataDir) {
  process.stderr.write(JSON.stringify({ error: { code: 'HOST_UNREACHABLE', message: 'no data dir' } }));
  process.exit(1);
}
const stateFile = path.join(dataDir, 'fake-host.json');
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { threads: {}, calls: [] };
  }
};
const save = state => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const after = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const out = value => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(0);
};
const error = (code, message) => {
  process.stderr.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};
const readStdin = () => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};
const planOf = text => {
  const line = String(text).split('\n').find(entry => entry.startsWith('FAKE '));
  return line ? JSON.parse(line.slice(5)) : {};
};

const state = load();
state.calls.push({
  args,
  env: Object.keys(process.env).filter(name => name.startsWith('CODEXHOST_') || name === 'CODEX_THREAD_ID' || name.startsWith('AGENTHUB_RELAY_')).sort(),
});

function startTurn(thread, text) {
  const plan = planOf(text);
  for (const [file, content] of Object.entries(plan.write ?? {})) {
    const full = path.join(thread.cwd, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const turn = {
    turnId: crypto.randomUUID(),
    input: text,
    readyAt: Date.now() + (plan.delayMs ?? 0),
    outcome: plan.fail ? 'failed' : 'completed',
    text: plan.message ?? 'done',
    questions: plan.ask ? [{ id: 'q-1', question: plan.ask, options: ['yes', 'no'] }] : [],
  };
  thread.turns.push(turn);
  return turn;
}

/** A turn's status now: running until it is ready, unless it asked or was interrupted. */
function statusOf(turn) {
  if (turn.interrupted) return 'interrupted';
  if (turn.questions.length) return 'running';
  return Date.now() >= turn.readyAt ? turn.outcome : 'running';
}

function snapshot(id, thread, timedOut = false) {
  const turn = thread.turns.at(-1);
  const status = statusOf(turn);
  return {
    threadId: id,
    harnessId: thread.harness,
    cwd: thread.cwd,
    title: thread.title,
    status,
    turn: { turnId: turn.turnId, status },
    progress: [],
    result: status === 'completed' || status === 'failed' ? { availability: 'available', text: turn.text } : { availability: 'unavailable' },
    pendingQuestions: turn.interrupted ? [] : turn.questions,
    timedOut,
  };
}

const [group, command, ref] = args;
if (group === 'delegate' && command === 'start') {
  const harness = after('--harness');
  const cwd = after('--cwd');
  if (!harness || !cwd) error('INVALID_ARGUMENT', '--harness and --cwd are required');
  if (harness === 'missing') error('HARNESS_NOT_FOUND', `harness ${harness} is not installed`);
  const id = crypto.randomUUID();
  const thread = { harness, cwd, title: after('--task-name') ?? 'task', model: after('--model'), thinking: after('--thinking'), turns: [] };
  const turn = startTurn(thread, readStdin());
  state.threads[id] = thread;
  save(state);
  out({ delegationId: crypto.randomUUID(), threadId: id, turnId: turn.turnId, harnessId: harness, deepLink: `codex://threads/${id}`, status: 'running', cwd, title: thread.title, parentThreadId: 'client:local-cli' });
}

const thread = state.threads[ref];
if (group === 'thread' && !thread) {
  save(state);
  error('THREAD_NOT_FOUND', `no thread ${ref}`);
}

if (group === 'thread' && command === 'send') {
  const current = thread.turns.at(-1);
  if (statusOf(current) === 'running') {
    if (!args.includes('--interrupt')) {
      save(state);
      error('THREAD_BUSY', 'the current Turn is still active');
    }
    current.interrupted = true;
  }
  const turn = startTurn(thread, readStdin());
  save(state);
  out({ threadId: ref, turnId: turn.turnId, harnessId: thread.harness, status: 'running' });
}

if (group === 'thread' && command === 'read') {
  save(state);
  out(snapshot(ref, thread));
}

if (group === 'thread' && command === 'cancel') {
  const current = thread.turns.at(-1);
  const active = statusOf(current) === 'running';
  if (active) current.interrupted = true;
  save(state);
  out({ threadId: ref, turnId: current.turnId, harnessId: thread.harness, cancelled: active });
}

if (group === 'thread' && command === 'wait') {
  save(state);
  const limit = Number(after('--timeout-ms') ?? 30000);
  const deadline = Date.now() + limit;
  const tick = () => {
    const fresh = load().threads[ref];
    const turn = fresh.turns.at(-1);
    const status = statusOf(turn);
    if (status !== 'running' || (turn.questions.length && !turn.interrupted)) out(snapshot(ref, fresh));
    if (Date.now() >= deadline) out(snapshot(ref, fresh, true));
    setTimeout(tick, 50);
  };
  tick();
} else if (group !== 'delegate') {
  save(state);
  error('INVALID_ARGUMENT', `unknown command ${args.join(' ')}`);
}
