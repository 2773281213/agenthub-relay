// The MCP server end to end: the real CLI over stdio, driven the way any
// MCP client drives it. The client name is deliberately not Claude's.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { test } from 'node:test';

import { CLI, fakeTask, makeRepo, useFakeExecutors, waitFor } from './helpers.mjs';

function startServer(dir) {
  const env = { ...process.env, AGENTHUB_RELAY_ROOT: dir };
  delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  const stray = [];
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += chunk));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    } else {
      stray.push(message);
    }
  });
  let nextId = 1;
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) => {
    const id = nextId++;
    const response = new Promise(resolve => waiting.set(id, resolve));
    send({ jsonrpc: '2.0', id, method, params });
    return { id, response };
  };
  const call = async (method, params) => (await request(method, params).response);
  const tool = async (name, args = {}) => {
    const message = await call('tools/call', { name, arguments: args });
    assert.ok(message.result, `tools/call ${name} answered ${JSON.stringify(message)}`);
    return { ...message.result, data: JSON.parse(message.result.content[0].text) };
  };
  const stop = () =>
    new Promise(resolve => {
      child.on('exit', resolve);
      child.stdin.end();
    });
  return { child, send, request, call, tool, stop, stray, stderr: () => stderr };
}

test('a non-Claude MCP client runs the whole relay flow', async () => {
  const { dir, cleanup } = makeRepo();
  const server = startServer(dir);
  try {
    useFakeExecutors(dir);
    const init = await server.call('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'codex-mcp-client', version: '1.0.0' },
    });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'agenthub-relay');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.match(init.result.instructions, /watcher\.active/);
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const listed = await server.call('tools/list', {});
    assert.deepEqual(listed.result.tools.map(t => t.name), [
      'relay_agents', 'relay_dispatch', 'relay_status', 'relay_wait', 'relay_result', 'relay_apply', 'relay_discard', 'relay_cancel',
    ]);
    for (const t of listed.result.tools) assert.equal(t.inputSchema.type, 'object');

    const agents = await server.tool('relay_agents');
    assert.equal(agents.data.profile, 'thread16');

    const dispatched = await server.tool('relay_dispatch', {
      tier: 'light',
      scope: ['src/app.txt'],
      checks: ['grep -q light src/app.txt'],
      task: fakeTask({ write: { 'src/app.txt': 'light edit\n' }, message: 'edited src/app.txt' }),
    });
    assert.equal(dispatched.data.executor, 'dsh');
    const jobId = dispatched.data.jobId;

    await waitFor(async () => (await server.tool('relay_wait', { jobIds: [jobId], timeoutSeconds: 5 })).data.finished.length > 0, {
      timeoutMs: 30_000,
      what: 'the job over MCP',
    });
    const result = await server.tool('relay_result', { jobId });
    assert.equal(result.data.status, 'completed');
    assert.equal(result.data.summary, 'edited src/app.txt');

    const job = JSON.parse(fs.readFileSync(`${dir}/.agenthub/jobs/${jobId}/job.json`, 'utf8'));
    assert.equal(job.planner.client, 'codex-mcp-client', 'the client name is recorded as a label only');
  } finally {
    await server.stop();
    cleanup();
  }
});

test('protocol errors and tool errors are reported the MCP way', async () => {
  const { dir, cleanup } = makeRepo();
  const server = startServer(dir);
  try {
    const init = await server.call('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'probe' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual((await server.call('ping')).result, {});
    assert.equal((await server.call('resources/list', {})).error.code, -32601);
    assert.equal((await server.call('tools/call', { name: 'relay_nope', arguments: {} })).error.code, -32602);

    const refused = await server.tool('relay_dispatch', { tier: 'light', scope: ['a.txt'], task: 'x' });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.error.code, 'light-needs-checks');

    server.child.stdin.write('{ not json\n');
    await waitFor(() => server.stray.find(m => m.error?.code === -32700), { what: 'a parse error' });
  } finally {
    await server.stop();
    cleanup();
  }
});

test('notifications/cancelled ends an in-flight relay_wait without a response', async () => {
  const { dir, cleanup } = makeRepo();
  const server = startServer(dir);
  try {
    useFakeExecutors(dir);
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe' } });
    const { data } = await server.tool('relay_dispatch', { tier: 'deep', scope: ['src'], task: fakeTask({ sleepMs: 60_000 }) });

    const wait = server.request('tools/call', { name: 'relay_wait', arguments: { timeoutSeconds: 50 } });
    let answered = false;
    wait.response.then(() => (answered = true));
    await new Promise(resolve => setTimeout(resolve, 300));
    server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: wait.id, reason: 'test' } });

    const started = Date.now();
    assert.deepEqual((await server.call('ping')).result, {});
    assert.ok(Date.now() - started < 2_000, 'the server stays responsive');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(answered, false, 'a cancelled request gets no response');

    await server.tool('relay_cancel', { jobId: data.jobId });
    await waitFor(async () => (await server.tool('relay_status', { jobId: data.jobId })).data.job.status === 'cancelled', {
      timeoutMs: 20_000,
      what: 'the cancel',
    });
  } finally {
    await server.stop();
    cleanup();
  }
});

test('a client that disconnects mid-wait lets the server exit at once', async () => {
  const { dir, cleanup } = makeRepo();
  const server = startServer(dir);
  try {
    useFakeExecutors(dir);
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe' } });
    const { data } = await server.tool('relay_dispatch', { tier: 'deep', scope: ['src'], task: fakeTask({ sleepMs: 60_000 }) });
    server.request('tools/call', { name: 'relay_wait', arguments: { timeoutSeconds: 50 } });
    await new Promise(resolve => setTimeout(resolve, 300));
    const started = Date.now();
    await server.stop();
    assert.ok(Date.now() - started < 5_000, `the server took ${Date.now() - started} ms to exit`);

    // The job itself keeps running in its detached worker; stop it for the test.
    const again = startServer(dir);
    try {
      await again.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe' } });
      await again.tool('relay_cancel', { jobId: data.jobId });
      await waitFor(async () => (await again.tool('relay_status', { jobId: data.jobId })).data.job.status === 'cancelled', {
        timeoutMs: 20_000,
        what: 'the cancel',
      });
    } finally {
      await again.stop();
    }
  } finally {
    cleanup();
  }
});
