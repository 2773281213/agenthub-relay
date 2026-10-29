// Executor adapters: how each agent CLI is run unattended and how its output
// is read back. Each adapter follows that CLI's documented headless interface:
//   codex  - `codex exec --json` (JSONL events on stdout, final message via -o)
//   claude - `claude -p --output-format json` (one JSON result on stdout)
//   dsh    - `dsh --profile headless "<task>"` (final answer on stdout, exit 0/1)
// Antigravity (agy) and the generic ACP executor are reserved and fail closed.

import path from 'node:path';

import { RESERVED } from './config.mjs';
import { locateCommand, resolveCommand } from './platform.mjs';

/** dsh takes the task as one argument; keep it well under the OS limit. */
export const MAX_ARGV_PROMPT_BYTES = 100_000;

/**
 * Variables an executor inherits without being named: locations, locale,
 * terminal, proxy and CA settings. Credentials pass only when the executor's
 * `passEnv` names them.
 */
export const BASE_ENV = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'TERM',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
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
  );
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
  if (job.checks?.length) {
    lines.push(`- When you finish, agenthub-relay runs these checks in this directory: ${job.checks.map(c => `\`${c}\``).join(', ')}. Run them yourself first if you can.`);
  }
  lines.push('- Finish with a short summary: what you changed, how you verified it, and anything left undone.');
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
  const lines = trimmed.split('\n').reverse();
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** The model and effort flags for a job, from the executor's argument templates. */
export function selectionArgs(job, cfg) {
  const fill = (template, placeholder, value) => (value === undefined ? [] : (template ?? []).map(arg => arg.split(placeholder).join(value)));
  return [...fill(cfg.modelArgs, '{model}', job.model), ...fill(cfg.effortArgs, '{effort}', job.effort)];
}

const ADAPTERS = Object.freeze({
  codex: {
    label: 'Codex CLI',
    invocation(job, cfg, files, prompt) {
      return {
        argv: [cfg.command, 'exec', '--json', '--sandbox', job.write ? 'workspace-write' : 'read-only', '-o', files.final, ...selectionArgs(job, cfg), ...cfg.extraArgs, '-'],
        stdin: prompt,
      };
    },
    parse({ exitCode, stdout, stderr, finalText }) {
      let sessionId;
      let usage;
      let failure;
      let lastMessage;
      for (const line of (stdout ?? '').split('\n')) {
        const text = line.trim();
        if (!text.startsWith('{')) continue;
        let event;
        try {
          event = JSON.parse(text);
        } catch {
          continue;
        }
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
  },
  claude: {
    label: 'Claude Code',
    invocation(job, cfg, files, prompt) {
      // In -p mode anything that would ask for permission is denied, so a
      // review needs no mode (the newer "manual" is "default" in older
      // releases, and --permission-prompts is not in them at all).
      const argv = [cfg.command, '-p', '--output-format', 'json'];
      if (job.write) argv.push('--permission-mode', 'acceptEdits');
      if (cfg.bare) argv.push('--bare');
      argv.push(...selectionArgs(job, cfg), ...cfg.extraArgs);
      // A variadic option goes last so that nothing after it is read as a tool.
      if (job.checks?.length) argv.push('--allowedTools', ...job.checks.map(check => `Bash(${check})`));
      return { argv, stdin: prompt };
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
  },
  dsh: {
    label: 'DeepSeek Harness',
    invocation(job, cfg, files, prompt) {
      if (Buffer.byteLength(prompt) > MAX_ARGV_PROMPT_BYTES) {
        throw fail('prompt-too-long', `dsh takes the task as one argument; this one is over ${MAX_ARGV_PROMPT_BYTES} bytes`);
      }
      return { argv: [cfg.command, '--profile', 'headless', ...selectionArgs(job, cfg), ...cfg.extraArgs, prompt], stdin: null };
    },
    parse({ exitCode, stdout, stderr }) {
      const ok = exitCode === 0;
      return { ok, summary: (stdout ?? '').trim(), error: ok ? undefined : tail(stderr) || `dsh exited with code ${exitCode}` };
    },
  },
});

/** The adapter for an executor id; reserved and unknown ids fail closed. */
export function adapterFor(id) {
  if (RESERVED[id]) throw fail('reserved-executor', RESERVED[id]);
  const adapter = ADAPTERS[id];
  if (!adapter) throw fail('unknown-executor', `No adapter for executor "${id}"`);
  return adapter;
}

/** What relay_agents reports: availability, mapping and reserved entries. */
export function describeExecutors(config, env = process.env) {
  const tiersOf = id => Object.entries(config.mapping).filter(([, executor]) => executor === id).map(([tier]) => tier);
  const live = Object.entries(config.executors).map(([id, cfg]) => {
    let resolved = null;
    let problem;
    try {
      resolved = resolveCommand(cfg.command, { env });
    } catch (err) {
      problem = err.message;
    }
    return {
      id,
      label: ADAPTERS[id].label,
      command: cfg.command,
      available: resolved !== null,
      path: resolved?.path,
      via: resolved?.via,
      problem,
      tiers: tiersOf(id),
      model: cfg.model,
      effort: cfg.effort,
      choosesModel: (cfg.modelArgs ?? []).length > 0,
      choosesEffort: (cfg.effortArgs ?? []).length > 0,
      timeoutMinutes: cfg.timeoutMinutes,
      passEnv: cfg.passEnv,
    };
  });
  const reserved = Object.entries(RESERVED).map(([id, reason]) => ({ id, reserved: true, available: false, reason, tiers: tiersOf(id) }));
  return [...live, ...reserved];
}
