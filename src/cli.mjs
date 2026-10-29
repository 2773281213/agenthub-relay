#!/usr/bin/env node
// agenthub-relay command line. Every planner that can run a shell uses the
// relay through these commands; MCP clients use `mcp`. Both go through the
// same createRelay().call(), so the records are the same either way.
//
// Output: JSON on stdout (exit 0); a tool error as {"error": {...}} on stdout
// (exit 1); a usage error on stderr (exit 2).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { configLayers, configPath, loadConfig, PLANNER_IDS, plannerFromName, SETTABLE_KEYS, userConfigPath, writeSetting } from './config.mjs';
import { describeExecutors } from './executors.mjs';
import { resolveCommand } from './platform.mjs';
import { serveMcp } from './mcp.mjs';
import { createStore, TERMINAL } from './store.mjs';
import { createRelay, resolveRoot, VERSION } from './tools.mjs';
import { runWorker } from './worker.mjs';

/** The longest `wait` from the command line; MCP clients keep the 50-second limit. */
const CLI_MAX_WAIT_SECONDS = 3600;

const HELP = `agenthub-relay ${VERSION}

Planning (JSON on stdout; add --planner <claude|codex|dsh|agy> to say who you are):
  agenthub-relay agents                      Executors, your profile and why, each tier's executor and model
  agenthub-relay dispatch --tier <deep|light|review> (--task <text> | --task-file <file|->)
                 [--scope <path>]... [--check <command>]... [--executor <id>]
                 [--model <name>] [--effort <level>] [--title <text>] [--acceptance <text>]
                 [--timeout-minutes <n>]
  agenthub-relay wait [<jobId>...] [--timeout <seconds>]   Until a job ends (default 50 s, at most ${CLI_MAX_WAIT_SECONDS})
  agenthub-relay result <jobId>              Summary, checks, changed and out-of-scope files, log paths
  agenthub-relay apply <jobId> [--allow-out-of-scope] [--force]
  agenthub-relay discard <jobId>
  agenthub-relay cancel <jobId>
  agenthub-relay status [<jobId>] [--json]   Jobs in this repository

Settings:
  agenthub-relay config show [--json]        Effective settings and where they come from
  agenthub-relay config set <key> <value> [--user]
  agenthub-relay config unset <key> [--user]
      keys: ${SETTABLE_KEYS.join(', ')}
      a tier value is executor[:model][@effort], for example claude:opus@high
      --user writes the user file instead of the project's .agenthub/config.json

Other:
  agenthub-relay mcp                         Serve the relay_* tools over stdio for any MCP client
  agenthub-relay doctor [--json]             Check the repository, settings and installed executors
  agenthub-relay worker <jobId>              Run one job (dispatch starts this for you)
  agenthub-relay --version

Environment:
  AGENTHUB_RELAY_PLANNER       who is planning, when --planner is not given
  AGENTHUB_RELAY_PROFILE       force a profile
  AGENTHUB_RELAY_ROOT          repository to serve (default: CLAUDE_PROJECT_DIR, then the working directory)
  AGENTHUB_RELAY_CONFIG        project configuration file (default: <root>/.agenthub/config.json)
  AGENTHUB_RELAY_USER_CONFIG   user configuration file (default: ~/.config/agenthub-relay/config.json)
`;

class UsageError extends Error {}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parse(args, options, { positionals = 'none' } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { planner: { type: 'string' }, ...options }, allowPositionals: positionals !== 'none', strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (positionals === 'one' && parsed.positionals.length !== 1) throw new UsageError('Expected exactly one job id');
  const planner = parsed.values.planner;
  if (planner !== undefined && !PLANNER_IDS.includes(planner)) {
    throw new UsageError(`--planner must be one of ${PLANNER_IDS.join(', ')}`);
  }
  return parsed;
}

function relayFor(planner) {
  return createRelay({ cwd: process.cwd(), env: process.env, planner, clientName: () => 'cli', maxWaitSeconds: CLI_MAX_WAIT_SECONDS });
}

/** Runs one relay tool and prints its result; a tool error becomes exit code 1. */
async function tool(planner, name, args, strip = ['watcher']) {
  const result = await relayFor(planner).call(name, args);
  for (const key of strip) delete result[key];
  print(result);
  return 0;
}

function readTask(values) {
  if (values.task !== undefined && values['task-file'] !== undefined) throw new UsageError('Give --task or --task-file, not both');
  if (values.task !== undefined) return values.task;
  const file = values['task-file'];
  if (file === undefined) throw new UsageError('dispatch needs --task <text> or --task-file <file|->');
  try {
    return fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err) {
    throw new UsageError(`Cannot read the task from ${file === '-' ? 'stdin' : file}: ${err.message}`);
  }
}

function number(value, flag) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`${flag} must be a number`);
  return parsed;
}

async function dispatch(args) {
  const { values } = parse(args, {
    tier: { type: 'string' },
    task: { type: 'string' },
    'task-file': { type: 'string' },
    scope: { type: 'string', multiple: true },
    check: { type: 'string', multiple: true },
    executor: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    title: { type: 'string' },
    acceptance: { type: 'string' },
    'timeout-minutes': { type: 'string' },
  });
  if (!values.tier) throw new UsageError('dispatch needs --tier <deep|light|review>');
  const request = {
    task: readTask(values),
    tier: values.tier,
    scope: values.scope,
    checks: values.check,
    executor: values.executor,
    model: values.model,
    effort: values.effort,
    title: values.title,
    acceptance: values.acceptance,
    timeoutMinutes: number(values['timeout-minutes'], '--timeout-minutes'),
  };
  for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];
  return tool(values.planner, 'relay_dispatch', request);
}

async function wait(args) {
  const { values, positionals } = parse(args, { timeout: { type: 'string' } }, { positionals: 'many' });
  const request = { timeoutSeconds: number(values.timeout, '--timeout') ?? 50 };
  if (positionals.length) request.jobIds = positionals;
  return tool(values.planner, 'relay_wait', request);
}

async function oneJob(name, args, flags = {}) {
  const { values, positionals } = parse(args, flags, { positionals: 'one' });
  const request = { jobId: positionals[0] };
  if (values['allow-out-of-scope']) request.allowOutOfScope = true;
  if (values.force) request.force = true;
  return tool(values.planner, name, request);
}

async function status(args) {
  const { values, positionals } = parse(args, { json: { type: 'boolean' }, all: { type: 'boolean' } }, { positionals: 'many' });
  if (positionals.length > 1) throw new UsageError('status takes at most one job id');
  const request = positionals.length ? { jobId: positionals[0] } : {};
  if (values.all) request.all = true;
  if (values.json || positionals.length) return tool(values.planner, 'relay_status', request);
  const { jobs } = await relayFor(values.planner).call('relay_status', request);
  if (jobs.length === 0) {
    process.stdout.write('No jobs in this repository.\n');
    return 0;
  }
  for (const job of jobs) {
    const state = TERMINAL.has(job.status) ? `${job.status}/${job.integration}` : job.status;
    const route = `${job.tier}→${job.executor}${job.model ? `:${job.model}` : ''}`;
    process.stdout.write(`${job.id}  ${state.padEnd(20)} ${route.padEnd(24)} ${job.verification ?? ''}  ${job.title}\n`);
  }
  return 0;
}

async function rootOrNull() {
  try {
    return await resolveRoot(process.cwd(), process.env);
  } catch {
    return null;
  }
}

function plannerOf(values) {
  return plannerFromName(values.planner ?? process.env.AGENTHUB_RELAY_PLANNER);
}

async function config(args) {
  const [sub, ...rest] = args;
  if (sub === 'show') {
    const { values } = parse(rest, { json: { type: 'boolean' } });
    const root = await rootOrNull();
    const settings = loadConfig({ root: root ?? undefined, env: process.env, planner: plannerOf(values) });
    const report = {
      root,
      planner: settings.planner,
      profile: settings.profile,
      profileReason: settings.profileReason,
      files: { user: userConfigPath(process.env), project: root ? configPath(root, process.env) : null, applied: settings.sources },
      routes: Object.fromEntries(Object.entries(settings.routes).map(([tier, route]) => {
        const executor = settings.executors[route.executor];
        return [tier, { ...route, model: route.model ?? executor?.model, effort: route.effort ?? executor?.effort }];
      })),
      plannerProfiles: settings.plannerProfiles,
      profiles: Object.keys(settings.profiles),
      executors: describeExecutors(settings, process.env),
    };
    if (values.json) {
      print(report);
      return 0;
    }
    const lines = [
      `planner: ${report.planner}${report.planner === 'unknown' ? ' (pass --planner or set AGENTHUB_RELAY_PLANNER)' : ''}`,
      `profile: ${report.profile} (${report.profileReason})`,
      'tiers:',
      ...Object.entries(report.routes).map(([tier, r]) => `  ${tier.padEnd(7)} ${r.executor}${r.model ? `  model ${r.model}` : '  model: executor default'}${r.effort ? `  effort ${r.effort}` : ''}`),
      `planner profiles: ${Object.entries(report.plannerProfiles).map(([p, name]) => `${p}→${name}`).join(', ')}`,
      `profiles: ${report.profiles.join(', ')}`,
      `files applied: ${report.files.applied.length ? report.files.applied.join(', ') : 'none (built-in defaults)'}`,
      `user file: ${report.files.user ?? 'none (no home directory)'}`,
      `project file: ${report.files.project ?? 'none (not in a git repository)'}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  if (sub === 'set' || sub === 'unset') {
    const { values, positionals } = parse(rest, { user: { type: 'boolean' } }, { positionals: 'many' });
    const wanted = sub === 'set' ? 2 : 1;
    if (positionals.length !== wanted) throw new UsageError(sub === 'set' ? 'config set <key> <value> [--user]' : 'config unset <key> [--user]');
    if (process.env.AGENTHUB_RELAY_ROLE === 'executor') {
      throw Object.assign(new Error('An agenthub-relay executor may not change the relay settings.'), { code: 'executor-role' });
    }
    let file;
    let layersBelow = [];
    if (values.user) {
      file = userConfigPath(process.env);
      if (!file) throw Object.assign(new Error('There is no home directory for a user configuration file'), { code: 'no-user-config' });
    } else {
      const root = await resolveRoot(process.cwd(), process.env);
      file = configPath(root, process.env);
      layersBelow = configLayers({ env: process.env }).filter(layer => layer.file !== file);
    }
    const [key, value] = positionals;
    const written = writeSetting({ file, key, value, unset: sub === 'unset', layersBelow });
    print(written);
    return 0;
  }
  throw new UsageError('config show | config set <key> <value> | config unset <key>');
}

function versionOf(command) {
  let resolved;
  try {
    resolved = resolveCommand(command, { env: process.env });
  } catch {
    return undefined;
  }
  if (!resolved) return undefined;
  const run = spawnSync(resolved.file, [...resolved.prefixArgs, '--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (run.error || run.status !== 0) return undefined;
  return run.stdout.trim().split('\n')[0] || undefined;
}

async function doctor(args) {
  const { values } = parse(args, { json: { type: 'boolean' } });
  const report = { version: VERSION, node: process.version, platform: process.platform };
  try {
    report.root = await resolveRoot(process.cwd(), process.env);
  } catch (err) {
    report.rootError = err.message;
  }
  try {
    const settings = loadConfig({ root: report.root, env: process.env, planner: plannerOf(values) });
    report.config = settings.sources.length ? settings.sources.join(', ') : 'built-in defaults';
    report.planner = settings.planner;
    report.profile = settings.profile;
    report.profileReason = settings.profileReason;
    report.mapping = settings.mapping;
    report.executors = describeExecutors(settings, process.env).map(entry =>
      entry.available ? { ...entry, version: versionOf(entry.command) } : entry,
    );
  } catch (err) {
    report.configError = err.message;
  }
  report.promptCacheTtl = process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null;
  if (values.json) {
    print(report);
    return 0;
  }
  const lines = [`agenthub-relay ${VERSION} on Node ${process.version} (${process.platform})`];
  lines.push(report.root ? `repository: ${report.root}` : `repository: none (${report.rootError})`);
  if (report.configError) {
    lines.push(`configuration error: ${report.configError}`);
  } else {
    const mapping = Object.entries(report.mapping).map(([tier, executor]) => `${tier}→${executor}`).join(', ');
    lines.push(`configuration: ${report.config}`, `planner: ${report.planner}`, `profile: ${report.profile} (${mapping}; ${report.profileReason})`, 'executors:');
    for (const entry of report.executors) {
      const tiers = entry.tiers.length ? ` [${entry.tiers.join(', ')}]` : '';
      if (entry.reserved) lines.push(`  ${entry.id.padEnd(7)} reserved   ${entry.reason}${tiers}`);
      else if (entry.available) lines.push(`  ${entry.id.padEnd(7)} available  ${entry.path}${entry.via === 'direct' ? '' : ` (${entry.via})`}${entry.version ? `  ${entry.version}` : ''}${tiers}`);
      else if (entry.problem) lines.push(`  ${entry.id.padEnd(7)} unusable   ${entry.problem}${tiers}`);
      else lines.push(`  ${entry.id.padEnd(7)} missing    "${entry.command}" is not on PATH${tiers}`);
    }
  }
  lines.push(`CLAUDE_CODE_PROMPT_CACHE_TTL: ${report.promptCacheTtl ?? 'unset (Claude Code default for your account)'}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function worker(jobId) {
  if (!jobId) throw new UsageError('Usage: agenthub-relay worker <jobId>');
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  const root = process.env.AGENTHUB_RELAY_ROOT ?? process.cwd();
  const job = await runWorker({ root, jobId, env: process.env, signal: controller.signal });
  process.stdout.write(`${job.id} ${job.status}\n`);
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'mcp': {
      let client = 'unknown';
      const relay = createRelay({ cwd: process.cwd(), env: process.env, clientName: () => client });
      await serveMcp({ relay, onClient: info => (client = typeof info?.name === 'string' ? info.name : 'unknown') });
      return 0;
    }
    case 'agents':
      return tool(parse(rest, {}).values.planner, 'relay_agents', {});
    case 'dispatch':
      return dispatch(rest);
    case 'wait':
      return wait(rest);
    case 'result':
      return oneJob('relay_result', rest);
    case 'apply':
      return oneJob('relay_apply', rest, { 'allow-out-of-scope': { type: 'boolean' }, force: { type: 'boolean' } });
    case 'discard':
      return oneJob('relay_discard', rest);
    case 'cancel':
      return oneJob('relay_cancel', rest);
    case 'status':
      return status(rest);
    case 'config':
      return config(rest);
    case 'worker':
      return worker(rest[0]);
    case 'doctor':
      return doctor(rest);
    case '--version':
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return command === undefined ? 2 : 0;
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  err => {
    if (err instanceof UsageError) {
      process.stderr.write(`agenthub-relay: ${err.message}\nRun "agenthub-relay help" for usage.\n`);
      process.exitCode = 2;
      return;
    }
    print({ error: { code: err.code ?? 'error', message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
    process.exitCode = 1;
  },
);
