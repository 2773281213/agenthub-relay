// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0) exposing
// the relay_* tools. Written against the Node standard library only, so any
// MCP client can load it: Claude Code, Codex, DeepSeek Harness, Antigravity.

import readline from 'node:readline';

import { MAX_WAIT_SECONDS, VERSION } from './tools.mjs';

/** Protocol revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

export const INSTRUCTIONS = [
  'agenthub-relay hands coding jobs to other agents (Codex, Claude Code, DeepSeek Harness), each in its own git worktree.',
  'Tiers: deep = complex work with a declared scope; light = simple, clearly specified work with 1-10 scope paths and at least one check command; review = read-only.',
  `After relay_dispatch: if the result says watcher.active, end your turn and you will be woken when the job ends; otherwise call relay_wait (it returns within ${MAX_WAIT_SECONDS} s) until a job finishes.`,
  'Then read relay_result and decide: relay_apply (changes land unstaged in your working tree) or relay_discard.',
].join(' ');

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * Serves one client until its input closes.
 *
 * @param {object} options
 * @param {object} options.relay createRelay() result
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {Function} [options.onClient] receives the client's clientInfo
 */
export function serveMcp({ relay, input = process.stdin, output = process.stdout, onClient } = {}) {
  const inFlight = new Map();
  let closed = false;
  output.on?.('error', () => {}); // a client that went away (EPIPE) is not our failure
  const send = message => {
    if (!closed) output.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function callTool(id, params) {
    const controller = new AbortController();
    inFlight.set(id, controller);
    try {
      if (typeof params?.name !== 'string') {
        replyError(id, INVALID_PARAMS, 'tools/call needs a tool name');
        return;
      }
      const result = await relay.call(params.name, params.arguments ?? {}, { signal: controller.signal });
      if (!controller.signal.aborted) reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      if (controller.signal.aborted) return; // a cancelled request gets no response
      if (err.code === 'unknown-tool') {
        replyError(id, INVALID_PARAMS, err.message);
        return;
      }
      const error = { code: err.code ?? 'internal-error', message: err.message, ...(err.details ? { details: err.details } : {}) };
      reply(id, { content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }], isError: true });
    } finally {
      inFlight.delete(id);
    }
  }

  async function handle(message) {
    if (Array.isArray(message) || message === null || typeof message !== 'object') {
      replyError(null, INVALID_REQUEST, 'Expected one JSON-RPC message per line');
      return;
    }
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          onClient?.(params?.clientInfo);
          reply(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'agenthub-relay', version: VERSION },
            instructions: INSTRUCTIONS,
          });
          return;
        }
        case 'ping':
          if (isRequest) reply(id, {});
          return;
        case 'tools/list':
          reply(id, { tools: relay.tools });
          return;
        case 'tools/call':
          await callTool(id, params);
          return;
        case 'notifications/cancelled':
          inFlight.get(params?.requestId)?.abort();
          return;
        default:
          if (isRequest) replyError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    } catch (err) {
      if (isRequest) replyError(id, INTERNAL_ERROR, err.message);
    }
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      replyError(null, PARSE_ERROR, 'Parse error');
      return;
    }
    handle(message);
  });
  return new Promise(resolve =>
    lines.on('close', () => {
      // The client is gone: stop what it was waiting for, so the process can exit.
      closed = true;
      for (const controller of inFlight.values()) controller.abort();
      resolve();
    }),
  );
}
