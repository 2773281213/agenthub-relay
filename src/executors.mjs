// Executor adapters: how each agent CLI is run unattended and how its output
// is read back. Each adapter follows that CLI's documented headless interface:
//   codex  - `codex exec --json` (JSONL events on stdout, final message via -o);
//            a follow-up turn is `codex exec resume <thread> ... -`
//   claude - `claude -p --output-format json` (one JSON result on stdout), with
//            the session id chosen up front (--session-id) and --resume after
//   dsh    - `dsh --profile headless --json -` (NDJSON events, the task on
//            stdin; --session-id continues a session); a dsh without --json
//            gets the task as its positional argument and cannot be continued
//   agy    - Antigravity CLI with `--input-format stream-json --output-format
//            stream-json`: the task as one user event on stdin, NDJSON events
//            on stdout ending in a `result` event; --conversation continues
// The generic ACP executor is reserved and fails closed.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RESERVED } from './config.mjs';
import { driveCodexhost } from './codexhost.mjs';
import { locateExecutor } from './discovery.mjs';
import { locateCommand, resolveCommand } from './platform.mjs';

/** dsh without --json takes the task as one argument; keep it well under the OS limit. */
export const MAX_ARGV_PROMPT_BYTES = 100_000;

/** Native session ids the relay passes back to a CLI or puts in a link: no shell or URL syntax. */
export const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Variables an executor inherits without being named: locations, locale,
 * terminal, proxy and CA settings. Credentials pass only when the executor's
 * `passEnv` names them.
 */
export const BASE_ENV = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'TERM',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Windows: programs need these to find the system, the user profile
  // (where codex, claude and dsh keep their sign-in) and temp folders.
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'TEMP', 'TMP',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
]);

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function tail(text, max = 600) {
  const trimmed = (text ?? '').trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

function jsonLine(line) {
  const text = (line ?? '').trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function events(stdout) {
  return (stdout ?? '').split('\n').map(jsonLine).filter(Boolean);
}

/** The absolute path `command` resolves to on PATH (with PATHEXT on Windows), or null. */
export function findOnPath(command, envPath = process.env.PATH ?? '', platform = process.platform) {
  const found = locateCommand(command, { env: { PATH: envPath }, platform });
  return found ? path.resolve(found) : null;
}

/**
 * What to spawn for an adapter's argv: its command resolved to the program
 * that actually runs (an .exe, or node plus the script an npm/pnpm shim wraps
 * on Windows), and the variables a launcher shim would have set. An unknown
 * command is left as is, so spawning it reports that it cannot start.
 */
export function spawnArgv(argv, { env = process.env, platform = process.platform } = {}) {
  const resolved = resolveCommand(argv[0], { env, platform });
  if (!resolved) return { argv, env: {} };
  return { argv: [resolved.file, ...resolved.prefixArgs, ...argv.slice(1)], env: resolved.env ?? {} };
}

/** The environment an executor runs with, and which named variables it got. */
export function childEnv(source, executorConfig, jobId) {
  const env = {};
  for (const name of BASE_ENV) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  const passed = [];
  for (const name of executorConfig.passEnv ?? []) {
    if (source[name] !== undefined) {
      env[name] = source[name];
      passed.push(name);
    }
  }
  env.AGENTHUB_RELAY_ROLE = 'executor';
  env.AGENTHUB_RELAY_JOB = jobId;
  return { env, passed };
}

function ruleLines(job) {
  const lines = [];
  if (job.write) {
    const scope = job.scope.includes('.') ? 'the whole repository' : job.scope.join(', ');
    lines.push(`- Change only files covered by this scope: ${scope}. Changes outside it are reported to the planner as out of scope.`);
  } else {
    lines.push('- This is a read-only review: do not create, modify or delete any file.');
  }
  lines.push(
    '- Do not commit, push or create branches; the planner reviews your changes and applies them.',
    '- Do not hand this work to other agents: this process runs as an agenthub-relay executor.',
  );
  return lines;
}

/** The instructions every executor receives, whichever agent it is. */
export function buildPrompt(job) {
  const lines = [
    `You are an executor dispatched by agenthub-relay (job ${job.id}, ${job.tier} tier).`,
    `Task: ${job.title}`,
    '',
    job.task,
    '',
  ];
  if (job.acceptance) lines.push('Acceptance criteria:', job.acceptance, '');
  const base = job.base?.commit ? ` from commit ${job.base.commit.slice(0, 12)}` : '';
  lines.push(
    'Rules:',
    `- Work only inside the current directory. It is a git worktree prepared for this job${base}.`,
    ...ruleLines(job),
  );
  if (job.checks?.length) {
    lines.push(`- When you finish, agenthub-relay runs these checks in this directory: ${job.checks.map(c => `\`${c}\``).join(', ')}. Run them yourself first if you can.`);
  }
  lines.push('- Finish with a short summary: what you changed, how you verified it, and anything left undone.');
  return lines.join('\n');
}

/** The message a follow-up turn sends into the executor's own session. */
export function buildFollowUpPrompt(job, turn) {
  const lines = [
    `agenthub-relay follow-up for job ${job.id} (${job.tier} tier), turn ${turn.n}:`,
    '',
    turn.message ?? '',
    '',
    'The rules of this job still hold:',
    '- Work only inside the current directory, the job\'s git worktree.',
    ...ruleLines(job),
  ];
  if (job.checks?.length) {
    lines.push(`- When you finish, agenthub-relay runs these checks again: ${job.checks.map(c => `\`${c}\``).join(', ')}.`);
  }
  lines.push('- Finish with a short summary of this turn: what you changed, how you verified it, and anything left undone.');
  return lines.join('\n');
}

function lastJsonObject(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through: look for the last line that is a JSON object
  }
  for (const line of trimmed.split('\n').reverse()) {
    const parsed = jsonLine(line);
    if (parsed) return parsed;
  }
  return undefined;
}

/** The model and effort flags for a job, from the executor's argument templates. */
export function selectionArgs(job, cfg) {
  const fill = (template, placeholder, value) => (value === undefined ? [] : (template ?? []).map(arg => arg.split(placeholder).join(value)));
  return [...fill(cfg.modelArgs, '{model}', job.model), ...fill(cfg.effortArgs, '{effort}', job.effort)];
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

// dsh: what a given installation's headless profile understands, by its help.
const dshProbes = new Map();

/**
 * Whether a dsh installation's headless profile has `--json` and
 * `--session-id` (dsh 0.2 and later). Cached by the resolved program and its
 * modification time, so an upgrade is noticed without restarting anything.
 */
export function dshCapabilities(command, { env = process.env, platform = process.platform, spawnSync = nodeSpawnSync } = {}) {
  let resolved;
  try {
    resolved = resolveCommand(command, { env, platform });
  } catch {
    return { json: false, sessions: false };
  }
  if (!resolved) return { json: false, sessions: false };
  let stamp = 0;
  try {
    stamp = fs.statSync(resolved.path).mtimeMs;
  } catch {
    // keep 0
  }
  const key = `${resolved.path}\0${stamp}`;
  if (dshProbes.has(key)) return dshProbes.get(key);
  const run = spawnSync(resolved.file, [...resolved.prefixArgs, '--profile', 'headless', '--help'], {
    encoding: 'utf8',
    env: { ...env, ...(resolved.env ?? {}) },
    timeout: 30_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const help = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const caps = { json: /--json\b/.test(help), sessions: /--session-id\b/.test(help) };
  dshProbes.set(key, caps);
  return caps;
}

function quoteArg(arg, platform) {
  if (/^[A-Za-z0-9._:/\\=@+-]+$/.test(arg)) return arg;
  return platform === 'win32' ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A command line to show a person, quoted for their shell. */
export function displayCommand(argv, platform = process.platform) {
  const [first, ...rest] = argv;
  const head = platform === 'win32' && /[\s"]/.test(first) ? `& ${quoteArg(first, platform)}` : quoteArg(first, platform);
  return [head, ...rest.map(arg => quoteArg(arg, platform))].join(' ');
}

const ADAPTERS = Object.freeze({
  codex: {
    label: 'Codex CLI',
    resumable: true,
    // turn.completed.usage is the thread's running total, not the turn's own
    // (measured on 26.1117: 25900 -> 51839 -> 77817 input over three turns).
    cumulativeUsage: true,
    invocation(job, cfg, files, prompt) {
      return {
        argv: [cfg.command, 'exec', '--json', '--sandbox', job.write ? 'workspace-write' : 'read-only', '-o', files.final, ...selectionArgs(job, cfg), ...cfg.extraArgs, '-'],
        stdin: prompt,
      };
    },
    // `codex exec resume` has no --sandbox flag: the same choice goes through -c.
    resume(job, cfg, files, prompt, sessionId) {
      return {
        argv: [
          cfg.command, 'exec', 'resume', '--json', '-o', files.final,
          '-c', `sandbox_mode="${job.write ? 'workspace-write' : 'read-only'}"`,
          ...selectionArgs(job, cfg), ...cfg.extraArgs, sessionId, '-',
        ],
        stdin: prompt,
      };
    },
    sessionFromLine(line) {
      const event = jsonLine(line);
      return event?.type === 'thread.started' && typeof event.thread_id === 'string' ? event.thread_id : undefined;
    },
    parse({ exitCode, stdout, stderr, finalText }) {
      let sessionId;
      let usage;
      let failure;
      let lastMessage;
      for (const event of events(stdout)) {
        if (event.type === 'thread.started') sessionId = event.thread_id ?? sessionId;
        else if (event.type === 'turn.completed') usage = event.usage ?? usage;
        else if (event.type === 'turn.failed') failure = event.error?.message ?? 'The Codex turn failed';
        else if (event.type === 'error') failure = event.message ?? event.error?.message ?? 'Codex reported an error';
        else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          lastMessage = event.item.text;
        }
      }
      const ok = exitCode === 0 && failure === undefined;
      return {
        ok,
        summary: (finalText ?? '').trim() || lastMessage || '',
        sessionId,
        usage,
        error: ok ? undefined : failure ?? (tail(stderr) || `codex exited with code ${exitCode}`),
      };
    },
    usage(parsed) {
      const u = parsed.usage ?? {};
      return compact({ inputTokens: number(u.input_tokens), cachedInputTokens: number(u.cached_input_tokens), outputTokens: number(u.output_tokens) });
    },
    takeover({ command, sessionId }) {
      return {
        app: { label: 'Codex desktop app', url: `codex://threads/${sessionId}`, verified: false, note: 'Codex Desktop opens codex:// links; whether it lists threads started by `codex exec` is not verified.' },
        terminal: { label: 'Codex CLI', argv: [command, 'resume', sessionId] },
      };
    },
  },
  claude: {
    label: 'Claude Code',
    resumable: true,
    invocation(job, cfg, files, prompt) {
      // In -p mode anything that would ask for permission is denied, so a
      // review needs no mode (the newer "manual" is "default" in older
      // releases, and --permission-prompts is not in them at all).
      const argv = [cfg.command, '-p', '--output-format', 'json'];
      if (job.native?.sessionId) argv.push('--session-id', job.native.sessionId);
      return { argv: claudeTail(argv, job, cfg), stdin: prompt };
    },
    resume(job, cfg, files, prompt, sessionId) {
      return { argv: claudeTail([cfg.command, '-p', '--resume', sessionId, '--output-format', 'json'], job, cfg), stdin: prompt };
    },
    sessionFromLine() {
      return undefined; // chosen up front with --session-id
    },
    parse({ exitCode, stdout, stderr }) {
      const result = lastJsonObject(stdout);
      const isError = result?.is_error === true;
      const ok = exitCode === 0 && !isError;
      const summary = typeof result?.result === 'string' ? result.result : (result ? '' : (stdout ?? '').trim());
      return {
        ok,
        summary,
        sessionId: result?.session_id,
        usage: result?.usage,
        costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
        error: ok ? undefined : (isError ? `${result.subtype ?? 'error'}: ${tail(summary) || 'Claude Code reported an error'}` : tail(stderr) || `claude exited with code ${exitCode}`),
      };
    },
    usage(parsed) {
      const u = parsed.usage ?? {};
      const read = number(u.cache_read_input_tokens);
      const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].map(number).filter(value => value !== undefined);
      return compact({
        inputTokens: parts.length ? parts.reduce((a, b) => a + b, 0) : undefined,
        cachedInputTokens: read,
        outputTokens: number(u.output_tokens),
        costUsd: number(parsed.costUsd),
      });
    },
    takeover({ command, sessionId }) {
      return {
        app: { label: 'Claude desktop app', argv: [command, '--desktop', '--resume', sessionId], verified: true },
        terminal: { label: 'Claude Code', argv: [command, '--resume', sessionId] },
      };
    },
  },
  dsh: {
    label: 'DeepSeek Harness',
    resumable: true,
    invocation(job, cfg, files, prompt, caps = {}) {
      if (caps.json) {
        return { argv: [cfg.command, '--profile', 'headless', '--json', ...selectionArgs(job, cfg), ...cfg.extraArgs, '-'], stdin: prompt };
      }
      if (Buffer.byteLength(prompt) > MAX_ARGV_PROMPT_BYTES) {
        throw fail('prompt-too-long', `dsh takes the task as one argument; this one is over ${MAX_ARGV_PROMPT_BYTES} bytes`);
      }
      return { argv: [cfg.command, '--profile', 'headless', ...selectionArgs(job, cfg), ...cfg.extraArgs, prompt], stdin: null };
    },
    resume(job, cfg, files, prompt, sessionId, caps = {}) {
      if (!caps.json || !caps.sessions) throw fail('resume-unsupported', 'This dsh has no --json and --session-id; upgrade DeepSeek Harness to continue its sessions');
      return {
        argv: [cfg.command, '--profile', 'headless', '--json', '--session-id', sessionId, ...selectionArgs(job, cfg), ...cfg.extraArgs, '-'],
        stdin: prompt,
      };
    },
    sessionFromLine(line) {
      const event = jsonLine(line);
      return event?.type === 'session' && typeof event.sessionId === 'string' ? event.sessionId : undefined;
    },
    parse({ exitCode, stdout, stderr, caps = {} }) {
      if (!caps.json) {
        const ok = exitCode === 0;
        return { ok, summary: (stdout ?? '').trim(), error: ok ? undefined : tail(stderr) || `dsh exited with code ${exitCode}` };
      }
      let sessionId;
      let final;
      let failure;
      let lastText;
      for (const event of events(stdout)) {
        if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
        else if (event.type === 'final') final = event;
        else if (event.type === 'error') failure = event.message ?? event.code ?? 'dsh reported an error';
        else if (event.type === 'text' && typeof event.text === 'string') lastText = event.text;
      }
      if (typeof final?.sessionId === 'string') sessionId = final.sessionId;
      const reason = final?.reason?.kind;
      // dsh's own rule: exit 0 and a completed final turn.
      const ok = exitCode === 0 && reason === 'completed';
      let error;
      if (!ok) {
        if (failure) error = failure;
        else if (final) error = `dsh ended the turn ${reason ?? 'without a terminal reason'}${tail(stderr) ? `: ${tail(stderr)}` : ''}`;
        else error = tail(stderr) || `dsh exited with code ${exitCode} without a final event`;
      }
      return { ok, summary: (typeof final?.text === 'string' ? final.text : lastText ?? '').trim(), sessionId, error };
    },
    usage() {
      return {};
    },
    takeover({ command, sessionId }) {
      return {
        terminal: { label: 'DeepSeek Harness (headless, one more turn)', argv: [command, '--profile', 'headless', '--session-id', sessionId, '<your message>'] },
        note: `DeepSeek Harness also lists this session (${sessionId}) in its web app (dsh web); open it there to continue interactively.`,
      };
    },
  },
  agy: {
    label: 'Antigravity CLI',
    resumable: true,
    invocation(job, cfg, files, prompt) {
      return agyInvocation(job, cfg, prompt, []);
    },
    resume(job, cfg, files, prompt, sessionId) {
      return agyInvocation(job, cfg, prompt, ['--conversation', sessionId]);
    },
    sessionFromLine(line) {
      const event = jsonLine(line);
      const id = event?.conversation_id ?? event?.result?.conversation_id;
      return typeof id === 'string' && id ? id : undefined;
    },
    parse({ exitCode, stdout, stderr }) {
      let result;
      let conversationId;
      let streamed = '';
      for (const event of events(stdout)) {
        if (typeof event.conversation_id === 'string' && event.conversation_id) conversationId = event.conversation_id;
        if (event.event === 'result' && event.result && typeof event.result === 'object') result = event.result;
        const step = event.event === 'step_update' ? event.step_update : undefined;
        if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') streamed += step.text_delta;
      }
      const status = result?.status;
      const ok = exitCode === 0 && status === 'SUCCESS';
      // A denial ends agy's turn, often before its final message: say what was
      // denied, so the planner knows why the answer is short or missing.
      const denied = (Array.isArray(result?.denied_actions) ? result.denied_actions : [])
        .map(entry => [entry?.action, entry?.display_name].filter(Boolean).join(' '))
        .filter(Boolean);
      let summary = typeof result?.response === 'string' && result.response.trim() ? result.response : streamed.trim();
      if (denied.length) {
        const note = `Antigravity denied: ${denied.join(', ')}.`;
        summary = summary ? `${summary.trimEnd()}\n\n${note}` : `${note} It ended its turn without a final message.`;
      }
      let error;
      if (!ok) {
        if (typeof result?.error === 'string' && result.error) error = `${status ?? 'ERROR'}: ${result.error}`;
        else if (status && status !== 'SUCCESS') error = `Antigravity ended the run with status ${status}${tail(stderr) ? `: ${tail(stderr)}` : ''}`;
        else error = tail(stderr) || (result ? `agy exited with code ${exitCode}` : `agy exited with code ${exitCode} without a result event`);
      }
      return {
        ok,
        summary,
        sessionId: result?.conversation_id || conversationId,
        usage: result?.usage,
        error,
      };
    },
    usage(parsed) {
      const u = parsed.usage ?? {};
      return compact({
        inputTokens: number(u.input_tokens),
        cachedInputTokens: number(u.cached_input_tokens ?? u.cache_read_input_tokens),
        outputTokens: number(u.output_tokens),
      });
    },
    takeover({ command, sessionId }) {
      return { terminal: { label: 'Antigravity CLI', argv: [command, '--conversation', sessionId] } };
    },
  },
  // Not a process per turn: the Host runs the harness and the worker drives
  // the codexhost CLI (codexhost.mjs). Its Threads are Codex Desktop Threads.
  codexhost: {
    label: 'codex-host',
    resumable: true,
    drive: driveCodexhost,
    sessionFromLine() {
      return undefined; // the driver reports the Thread id itself
    },
    usage() {
      return {};
    },
    takeover({ command, sessionId }) {
      return {
        app: { label: 'Codex desktop app (codexhost Thread)', url: `codex://threads/${sessionId}`, verified: true },
        terminal: { label: 'codexhost CLI', argv: [command, 'thread', 'read', sessionId, '--format', 'text'] },
        note: 'The Thread is the codexhost Host\'s: open it in Codex Desktop to continue it; the CLI command shows where it stands.',
      };
    },
  },
});

function claudeTail(argv, job, cfg) {
  if (job.write) argv.push('--permission-mode', 'acceptEdits');
  if (cfg.bare) argv.push('--bare');
  argv.push(...selectionArgs(job, cfg), ...cfg.extraArgs);
  // A variadic option goes last so that nothing after it is read as a tool.
  if (job.checks?.length) argv.push('--allowedTools', ...job.checks.map(check => `Bash(${check})`));
  return argv;
}

function agyInvocation(job, cfg, prompt, extra) {
  // Streaming input takes the task on stdin, so its length is not bound by
  // the command line; closing stdin ends the run after this one turn.
  const argv = [cfg.command, '--input-format', 'stream-json', '--output-format', 'stream-json', ...extra];
  // Headless, whatever would ask for approval is denied, and a denial ends
  // the turn. Rules go in --settings, which lasts for this run only and
  // never touches the user's settings.json. Even in its default mode agy
  // writes inside its workspace, so a review denies writes and commands
  // outright; a write tier accepts edits and may run its checks.
  let settings;
  if (job.write) {
    argv.push('--mode', 'accept-edits');
    if (job.checks?.length) settings = { permissions: { allow: job.checks.map(check => `command(${check})`) } };
  } else {
    settings = { permissions: { deny: ['write_file(*)', 'command(*)'] } };
  }
  if (settings) argv.push('--settings', JSON.stringify(settings));
  argv.push(...selectionArgs(job, cfg), ...cfg.extraArgs);
  return {
    argv,
    stdin: `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
    // The CLI updates itself; not in the middle of a job.
    env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  };
}

/** The adapter for an executor id; reserved and unknown ids fail closed. */
export function adapterFor(id) {
  if (RESERVED[id]) throw fail('reserved-executor', RESERVED[id]);
  const adapter = ADAPTERS[id];
  if (!adapter) throw fail('unknown-executor', `No adapter for executor "${id}"`);
  return adapter;
}

/** One run's usage in the relay's own field names: inputTokens (cached included), cachedInputTokens, outputTokens, costUsd. */
export function normalizeUsage(executor, parsed) {
  try {
    return adapterFor(executor).usage(parsed ?? {});
  } catch {
    return {};
  }
}

/**
 * A turn's own usage. An executor that reports its session's running total
 * (`cumulativeUsage`) gets the increase over the last earlier turn that
 * recorded one; a resumed turn with no such earlier figure has no own usage,
 * only `sessionUsage`. Returns { usage?, sessionUsage? }.
 */
export function turnUsage(executor, normalized, earlierTurns = [], { resumed = false } = {}) {
  if (!normalized || !Object.keys(normalized).length) return {};
  let cumulative = false;
  try {
    cumulative = adapterFor(executor).cumulativeUsage === true;
  } catch {
    // an unknown executor reports per run
  }
  if (!cumulative) return { usage: normalized };
  const before = [...earlierTurns].reverse().find(turn => turn?.sessionUsage)?.sessionUsage;
  if (!before) return resumed ? { sessionUsage: normalized } : { usage: normalized, sessionUsage: normalized };
  const usage = {};
  for (const [key, value] of Object.entries(normalized)) {
    const delta = value - (before[key] ?? 0);
    if (Number.isFinite(delta) && delta >= 0) usage[key] = delta;
  }
  return { usage, sessionUsage: normalized };
}

/**
 * What relay_agents reports: availability, mapping and reserved entries, and
 * for each executor the model and effort its own settings choose (`defaults`,
 * agent id -> models.agentDefault) for when the relay passes none. An
 * executor found outside PATH (discovery.mjs) says so with `discovered`.
 */
export function describeExecutors(config, env = process.env, defaults = {}, { platform = process.platform } = {}) {
  const tiersOf = id => Object.entries(config.mapping).filter(([, executor]) => executor === id).map(([tier]) => tier);
  const live = Object.entries(config.executors).map(([id, cfg]) => {
    const located = locateExecutor(id, cfg.command, { env, platform });
    const resolved = located.resolved;
    return {
      id,
      label: ADAPTERS[id].label,
      command: cfg.command,
      available: resolved !== null,
      path: resolved?.path,
      via: resolved?.via,
      ...(located.discovered ? { discovered: true, foundAt: located.command } : {}),
      problem: located.problem,
      tiers: tiersOf(id),
      model: cfg.model,
      effort: cfg.effort,
      choosesModel: (cfg.modelArgs ?? []).length > 0,
      choosesEffort: (cfg.effortArgs ?? []).length > 0,
      resumable: ADAPTERS[id].resumable === true,
      ...(defaults[id] ? { agentDefault: defaults[id] } : {}),
      timeoutMinutes: cfg.timeoutMinutes,
      passEnv: cfg.passEnv,
    };
  });
  const reserved = Object.entries(RESERVED).map(([id, reason]) => ({ id, reserved: true, available: false, reason, tiers: tiersOf(id) }));
  return [...live, ...reserved];
}
