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
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Several of these processes run at once (workers, a waker, a test reading
// along), as calls to a real Host do: each call holds a lock while it reads
// and rewrites the state, and the state is replaced whole, never half written.
const lockDir = path.join(dataDir, 'fake-host.lock');
let locked = false;
function lock() {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      locked = true;
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 15_000) fs.rmdirSync(lockDir); // left by a killed call
      } catch {
        // gone meanwhile
      }
      if (Date.now() > deadline) throw new Error('fake codexhost: state lock timed out');
      pause(5);
    }
  }
}
function unlock() {
  if (!locked) return;
  locked = false;
  try {
    fs.rmdirSync(lockDir);
  } catch {
    // gone already
  }
}
process.on('exit', unlock);

const load = () => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return { threads: {}, calls: [] };
      if (attempt >= 50) throw err;
      pause(10); // Windows: the file is being replaced this moment
    }
  }
};
const save = state => {
  const temp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, stateFile);
      return;
    } catch (err) {
      if (attempt >= 50) throw err;
      pause(10); // a reader has it open this moment
    }
  }
};
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

lock();
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
  const turnId = crypto.randomUUID();
  const turn = {
    turnId,
    input: text,
    readyAt: Date.now() + (plan.delayMs ?? 0),
    outcome: plan.fail ? 'failed' : 'completed',
    text: plan.message ?? 'done',
    // codexhost's shape: the harness's own question data under `request`. A
    // native requestUserInput pauses the turn until it is answered.
    questions: plan.ask
      ? [{
          interactionId: `q-${turnId}`, kind: 'requestUserInput', turnId,
          request: { questions: [{ id: 'decision', header: 'Question', question: plan.ask, options: [{ label: 'yes', description: 'go on' }, { label: 'no' }] }] },
        }]
      : [],
  };
  // An asynchronous question does not pause its turn, and stays open after it.
  if (plan.askAsync) {
    thread.asyncQuestions = [...(thread.asyncQuestions ?? []), { interactionId: `a-${turnId}`, kind: 'requestUserInputAsync', turnId, request: { title: plan.askAsync, options: ['a', 'b'] } }];
  }
  thread.turns.push(turn);
  return turn;
}

/**
 * A turn's status now: running until it is ready, unless it asked or was
 * interrupted. A turn seeded with `holdUntil` runs until a test writes the
 * file `release-<that name>` into the data folder (a planner's own turn).
 */
function statusOf(turn) {
  if (turn.interrupted) return 'interrupted';
  if (turn.holdUntil && !fs.existsSync(path.join(dataDir, `release-${turn.holdUntil}`))) return 'running';
  if (turn.questions.length) return 'running';
  return Date.now() >= turn.readyAt ? turn.outcome : 'running';
}

function pendingOf(thread) {
  const turn = thread.turns.at(-1);
  return [...(turn.interrupted ? [] : turn.questions), ...(thread.asyncQuestions ?? [])];
}

function snapshot(id, thread, timedOut = false) {
  // A harness whose start went wrong: the Thread is done without any turn
  // (seen with opencode and antigravity on 0.23.0).
  if (thread.lostTurn) {
    return { threadId: id, harnessId: thread.harness, cwd: thread.cwd, title: thread.title, status: 'completed', turn: null, progress: [], result: { availability: 'unavailable' }, pendingQuestions: [], timedOut };
  }
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
    pendingQuestions: pendingOf(thread),
    timedOut,
  };
}

const [group, command, ref] = args;
if (group === 'harness' && command === 'list') {
  save(state);
  out({ harnesses: Array.isArray(state.harnesses) ? state.harnesses : ['fakeh', 'antigravity', 'claude-code'] });
}

if (group === 'delegate' && command === 'start') {
  const harness = after('--harness');
  const cwd = after('--cwd');
  if (!harness || !cwd) error('INVALID_ARGUMENT', '--harness and --cwd are required');
  if (harness === 'missing') error('HARNESS_NOT_FOUND', `harness ${harness} is not installed`);
  const id = crypto.randomUUID();
  const thread = { harness, cwd, title: after('--task-name') ?? 'task', model: after('--model'), thinking: after('--thinking'), turns: [] };
  const input = readStdin();
  const turn = startTurn(thread, input);
  if (planOf(input).lostTurn) thread.lostTurn = true;
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
  const input = readStdin();
  state.calls.at(-1).input = input; // what was sent, also when it is refused
  const current = thread.turns.at(-1);
  if (statusOf(current) === 'running') {
    if (!args.includes('--interrupt')) {
      save(state);
      error('THREAD_BUSY', 'the current Turn is still active');
    }
    current.interrupted = true;
  }
  const turn = startTurn(thread, input);
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
  unlock(); // the wait only reads from here on; other calls go ahead meanwhile
  const limit = Number(after('--timeout-ms') ?? 30000);
  const deadline = Date.now() + limit;
  const tick = () => {
    const fresh = load().threads[ref];
    const turn = fresh.turns.at(-1);
    const status = statusOf(turn);
    // Any pending question returns at once, as in codexhost (an asynchronous one too).
    if (status !== 'running' || pendingOf(fresh).length) out(snapshot(ref, fresh));
    if (Date.now() >= deadline) out(snapshot(ref, fresh, true));
    setTimeout(tick, 50);
  };
  tick();
} else if (group !== 'delegate') {
  save(state);
  error('INVALID_ARGUMENT', `unknown command ${args.join(' ')}`);
}
