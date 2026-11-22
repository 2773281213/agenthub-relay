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

import { configLayers, configPath, loadConfig, parseRoute, PLANNER_IDS, plannerFromName, SETTABLE_KEYS, userConfigPath, writeSetting } from './config.mjs';
import { describeExecutors } from './executors.mjs';
import { installSkills, skillSource, skillTargets } from './install.mjs';
import { agentDefaults, assertRoute, catalogFor, MODEL_AGENTS } from './models.mjs';
import { resolveCommand } from './platform.mjs';
import { serveMcp } from './mcp.mjs';
import { isExecutorCaller } from './policy.mjs';
import { createStore, TERMINAL } from './store.mjs';
import { createRelay, resolveRoot, VERSION } from './tools.mjs';
import { runWorker } from './worker.mjs';
import { codexhostCommand, runWaker } from './wake.mjs';

/** The longest `wait` from the command line; MCP clients keep the 50-second limit. */
const CLI_MAX_WAIT_SECONDS = 3600;

const HELP = `agenthub-relay ${VERSION}

A planner session comes first (JSON on stdout; add --planner <claude|codex|dsh|agy> to say who you are):
  agenthub-relay session start --planner <you> [--refresh]
                 Lists the saved roles: each tier's executor, model and effort, each agent's own
                 default model and the check of each. Show this to the user and ask.
  agenthub-relay session confirm <sessionId> (--reuse | [--deep <route>] [--light <route>] [--review <route>]) [--user]
                 Keep the saved roles, or check the user's changes and save them (route: executor[:model][@effort])
  agenthub-relay session show [<sessionId>]

Planning:
  agenthub-relay agents                      Executors, your profile and why, each tier's executor and model
  agenthub-relay models [codex|claude|dsh|agy] [--refresh]   The models each agent offers and uses by default
  agenthub-relay models check <agent> [<model>] [--effort <level>]
  agenthub-relay dispatch --session <sessionId> --tier <deep|light|review> (--task <text> | --task-file <file|->)
                 [--scope <path>]... [--check <command>]... [--executor <id|codexhost/<harness>>]
                 [--harness <id>] [--model <name>] [--effort <level>] [--title <text>] [--acceptance <text>]
                 [--timeout-minutes <n>]
  agenthub-relay wait [<jobId>...] [--timeout <seconds>]   Until a job ends (default 50 s, at most ${CLI_MAX_WAIT_SECONDS})
  agenthub-relay result <jobId> [--format json|text]   Summary, checks, changed and out-of-scope files, turns, next steps
  agenthub-relay apply <jobId> [--allow-out-of-scope] [--force]
  agenthub-relay discard <jobId> [--force]
  agenthub-relay cancel <jobId>
  agenthub-relay status [<jobId>] [--json]   Jobs in this repository

A job is a conversation with its executor, in its own worktree:
  agenthub-relay send <jobId> (--message <text> | --message-file <file|->) [--interrupt] [--force] [--session <id>]
                 Continue the same executor session: fixes after review, an answer, or resuming
                 an interrupted job. --interrupt stops a running turn first.
  agenthub-relay takeover <jobId> [--stop] [--open]
                 How to open the job's session yourself, in the executor's desktop app or a
                 terminal; --open opens the app, --stop stops a running turn first
  agenthub-relay collect <jobId>             Hand a taken-over job back: its checks run and its patch is collected again

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
  agenthub-relay install-skills [--to claude|agents|all] [--force] [--dry-run]
                 Install or update the skill copies in ~/.claude/skills and ~/.agents/skills;
                 a copy someone changed is reported, and replaced only with --force (after a backup
                 to <skills folder>-backups)
  agenthub-relay worker <jobId>              Run one job (dispatch starts this for you)
  agenthub-relay --version

Environment:
  AGENTHUB_RELAY_PLANNER       who is planning, when --planner is not given
  AGENTHUB_RELAY_SESSION       the confirmed session, when --session is not given
  AGENTHUB_RELAY_PROFILE       force a profile
  AGENTHUB_RELAY_ROOT          repository to serve (default: CLAUDE_PROJECT_DIR, then the working directory)
  AGENTHUB_RELAY_CONFIG        project configuration file (default: <root>/.agenthub/config.json)
  AGENTHUB_RELAY_USER_CONFIG   user configuration file (default: ~/.config/agenthub-relay/config.json)
  AGENTHUB_RELAY_DISCOVERY     off: use only PATH to find codex, claude, dsh and agy (default: also their install folders)
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

function readText(values, flag, what) {
  if (values[flag] !== undefined && values[`${flag}-file`] !== undefined) throw new UsageError(`Give --${flag} or --${flag}-file, not both`);
  if (values[flag] !== undefined) return values[flag];
  const file = values[`${flag}-file`];
  if (file === undefined) throw new UsageError(`${what} needs --${flag} <text> or --${flag}-file <file|->`);
  try {
    return fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err) {
    throw new UsageError(`Cannot read the ${flag} from ${file === '-' ? 'stdin' : file}: ${err.message}`);
  }
}

function readTask(values) {
  return readText(values, 'task', 'dispatch');
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
    harness: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    title: { type: 'string' },
    acceptance: { type: 'string' },
    'timeout-minutes': { type: 'string' },
    session: { type: 'string' },
  });
  if (!values.tier) throw new UsageError('dispatch needs --tier <deep|light|review>');
  const request = {
    session: values.session ?? (process.env.AGENTHUB_RELAY_SESSION || undefined),
    task: readTask(values),
    tier: values.tier,
    scope: values.scope,
    checks: values.check,
    executor: values.executor,
    harness: values.harness,
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
  if (values.stop) request.stop = true;
  if (values.open) request.open = true;
  if (values.session) request.session = values.session;
  return tool(values.planner, name, request);
}

async function send(args) {
  const { values, positionals } = parse(args, {
    message: { type: 'string' },
    'message-file': { type: 'string' },
    interrupt: { type: 'boolean' },
    force: { type: 'boolean' },
    session: { type: 'string' },
  }, { positionals: 'one' });
  const request = { jobId: positionals[0], message: readText(values, 'message', 'send') };
  if (values.interrupt) request.interrupt = true;
  if (values.force) request.force = true;
  const session = values.session ?? (process.env.AGENTHUB_RELAY_SESSION || undefined);
  if (session) request.session = session;
  return tool(values.planner, 'relay_send', request);
}

/** `key: value` lines, then `---` and the summary as written, for planners that read text better than escaped JSON. */
function resultText(result) {
  const lines = [
    `job: ${result.id}   executor: ${result.executor}${result.model ? `:${result.model}` : ''}   tier: ${result.tier}   turn: ${result.turn}`,
    `status: ${result.status}${result.needsInput ? ' (needs input)' : ''}   verification: ${result.verification ?? '-'}   integration: ${result.integration}${result.takenOver ? '   taken over' : ''}`,
    `title: ${result.title}`,
  ];
  if (result.error) lines.push(`error: ${result.error.code}: ${result.error.message}`);
  // What a job waiting for an answer asked: answer it with send.
  for (const question of result.needsInput?.questions ?? []) {
    lines.push(`question: ${question.text}`);
    if (question.options?.length) lines.push(`options: ${question.options.join(' / ')}`);
  }
  lines.push(`changed: ${result.changedFiles.length ? result.changedFiles.join(', ') : 'nothing'}`);
  if (result.outOfScope.length) lines.push(`out of scope: ${result.outOfScope.join(', ')}`);
  for (const check of result.checks) lines.push(`check ${check.status}: ${check.command}${check.summary ? `  (${check.summary})` : ''}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (result.native?.sessionId) lines.push(`session: ${result.native.sessionId}`);
  if (result.usage) lines.push(`usage: ${Object.entries(result.usage).map(([key, value]) => `${key} ${value}`).join(', ')}`);
  for (const turn of result.turns.length > 1 ? result.turns : []) {
    lines.push(`turn ${turn.n}: ${turn.kind} by ${turn.by}, ${turn.status}${turn.verification ? `/${turn.verification}` : ''}${turn.message ? ` - ${turn.message.split('\n')[0]}` : ''}`);
  }
  lines.push(`patch: ${result.logs.patch}   executor log: ${result.logs.executor}`);
  for (const step of result.next) lines.push(`next: ${step.cli ?? '-'}  (${step.why})`);
  lines.push('---', result.summary ?? '');
  return `${lines.join('\n')}\n`;
}

async function result(args) {
  const { values, positionals } = parse(args, { format: { type: 'string' } }, { positionals: 'one' });
  const format = values.format ?? 'json';
  if (!['json', 'text'].includes(format)) throw new UsageError('--format must be json or text');
  const answer = await relayFor(values.planner).call('relay_result', { jobId: positionals[0] });
  if (format === 'text') {
    process.stdout.write(resultText(answer));
    return 0;
  }
  print(answer);
  return 0;
}

async function installSkillsCommand(args) {
  const { values } = parse(args, { to: { type: 'string' }, force: { type: 'boolean' }, 'dry-run': { type: 'boolean' } });
  const to = values.to ?? 'all';
  const all = skillTargets(process.env);
  if (!['claude', 'agents', 'all'].includes(to)) throw new UsageError('--to must be claude, agents or all');
  const targets = to === 'all' ? all : { [to]: all[to] };
  const results = installSkills({ source: skillSource(), targets, force: values.force === true, dryRun: values['dry-run'] === true, version: VERSION });
  const conflicts = results.filter(entry => entry.status === 'conflict');
  print({
    version: VERSION,
    source: skillSource(),
    results,
    ...(conflicts.length
      ? { note: 'Copies with changed files were left alone. Look at the files listed, then run again with --force to replace them (each is backed up first).' }
      : {}),
  });
  return conflicts.length ? 1 : 0;
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
    const ended = job.needsInput ? `needs-input/${job.integration}` : `${job.status}/${job.integration}`;
    const state = `${TERMINAL.has(job.status) ? ended : job.status}${job.takenOver ? ' (taken over)' : ''}`;
    const route = `${job.tier}->${job.executor}${job.model ? `:${job.model}` : ''}`;
    const turn = job.turn > 1 ? `turn ${job.turn}  ` : '';
    process.stdout.write(`${job.id}  ${state.padEnd(20)} ${route.padEnd(24)} ${job.verification ?? ''}  ${turn}${job.title}\n`);
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

async function session(args) {
  const [sub, ...rest] = args;
  if (sub === 'start') {
    const { values } = parse(rest, { refresh: { type: 'boolean' } });
    const request = { action: 'start' };
    if (values.planner) request.planner = values.planner;
    if (values.refresh) request.refresh = true;
    return tool(values.planner, 'relay_session', request);
  }
  if (sub === 'confirm') {
    const { values, positionals } = parse(
      rest,
      { reuse: { type: 'boolean' }, deep: { type: 'string' }, light: { type: 'string' }, review: { type: 'string' }, user: { type: 'boolean' } },
      { positionals: 'one' },
    );
    const request = { action: 'confirm', session: positionals[0] };
    if (values.reuse) request.reuse = true;
    for (const tier of ['deep', 'light', 'review']) if (values[tier] !== undefined) request[tier] = values[tier];
    if (values.user) request.user = true;
    return tool(values.planner, 'relay_session', request);
  }
  if (sub === 'show') {
    const { values, positionals } = parse(rest, {}, { positionals: 'many' });
    if (positionals.length > 1) throw new UsageError('session show takes at most one session id');
    const request = { action: 'show' };
    const id = positionals[0] ?? (process.env.AGENTHUB_RELAY_SESSION || undefined);
    if (id) request.session = id;
    return tool(values.planner, 'relay_session', request);
  }
  throw new UsageError('session start --planner <you> | session confirm <sessionId> (--reuse | --deep/--light/--review <route>) | session show [<sessionId>]');
}

async function models(args) {
  if (args[0] === 'check') {
    const { values, positionals } = parse(args.slice(1), { effort: { type: 'string' }, refresh: { type: 'boolean' } }, { positionals: 'many' });
    if (positionals.length < 1 || positionals.length > 2) throw new UsageError('models check <agent> [<model>] [--effort <level>]');
    const [agent, model] = positionals;
    const root = await rootOrNull();
    const settings = loadConfig({ root: root ?? undefined, env: process.env, planner: plannerOf(values) });
    const entry = await catalogFor(agent, { env: process.env, root: root ?? undefined, config: settings, refresh: values.refresh === true, clientVersion: VERSION });
    const route = { executor: agent, ...(model ? { model } : {}), ...(values.effort ? { effort: values.effort } : {}) };
    const check = assertRoute(route, entry, agent);
    print({ agent, ...(model ? { model } : {}), ...(values.effort ? { effort: values.effort } : {}), ...check, default: entry.default });
    return 0;
  }
  const { values, positionals } = parse(args, { refresh: { type: 'boolean' } }, { positionals: 'many' });
  if (positionals.length > 1) throw new UsageError('models [codex|claude|dsh|agy] [--refresh]');
  const request = positionals.length ? { agent: positionals[0] } : {};
  if (values.refresh) request.refresh = true;
  return tool(values.planner, 'relay_models', request);
}

/** Checks the model and effort a setting would give a route, the way session confirm does. */
async function checkSettingModel(key, value, root) {
  let route;
  const tierKey = /^profiles\.[A-Za-z0-9_-]+\.(deep|light|review)$/.exec(key);
  const executorKey = /^executors\.([a-z]+)\.(model|effort)$/.exec(key);
  if (tierKey) {
    const parsed = parseRoute(value);
    route = typeof parsed === 'string' ? { executor: parsed } : parsed;
    if (route.model === undefined && route.effort === undefined) return;
  } else if (executorKey) {
    route = { executor: executorKey[1], [executorKey[2]]: value };
  } else {
    return;
  }
  if (!MODEL_AGENTS.includes(route.executor)) return;
  const settings = loadConfig({ root: root ?? undefined, env: process.env });
  const entry = await catalogFor(route.executor, { env: process.env, root: root ?? undefined, config: settings, clientVersion: VERSION });
  assertRoute(route, entry, key);
}

async function config(args) {
  const [sub, ...rest] = args;
  if (sub === 'show') {
    const { values } = parse(rest, { json: { type: 'boolean' } });
    const root = await rootOrNull();
    const settings = loadConfig({ root: root ?? undefined, env: process.env, planner: plannerOf(values) });
    const defaults = agentDefaults({ env: process.env, root: root ?? undefined });
    const report = {
      root,
      planner: settings.planner,
      profile: settings.profile,
      profileReason: settings.profileReason,
      sessionsRequired: settings.sessions.required,
      files: { user: userConfigPath(process.env), project: root ? configPath(root, process.env) : null, applied: settings.sources },
      routes: Object.fromEntries(Object.entries(settings.routes).map(([tier, route]) => {
        const executor = settings.executors[route.executor];
        return [tier, { ...route, model: route.model ?? executor?.model, effort: route.effort ?? executor?.effort }];
      })),
      agentDefaults: defaults,
      plannerProfiles: settings.plannerProfiles,
      profiles: Object.keys(settings.profiles),
      executors: describeExecutors(settings, process.env, defaults),
    };
    if (values.json) {
      print(report);
      return 0;
    }
    const lines = [
      `planner: ${report.planner}${report.planner === 'unknown' ? ' (pass --planner or set AGENTHUB_RELAY_PLANNER)' : ''}`,
      `profile: ${report.profile} (${report.profileReason})`,
      'tiers:',
      ...Object.entries(report.routes).map(([tier, r]) => `  ${tier.padEnd(7)} ${r.executor}${r.model ? `  model ${r.model}` : `  model: ${ownDefault(report.agentDefaults[r.executor], r.executor)}`}${r.effort ? `  effort ${r.effort}` : ''}`),
      `sessions: ${report.sessionsRequired ? 'required (start and confirm a planner session before dispatching)' : 'not required'}`,
      `planner profiles: ${Object.entries(report.plannerProfiles).map(([p, name]) => `${p}->${name}`).join(', ')}`,
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
    const here = await rootOrNull();
    if (isExecutorCaller(process.env, here ? createStore(here).list() : [])) {
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
    if (sub === 'set') await checkSettingModel(key, value, await rootOrNull());
    const written = writeSetting({ file, key, value, unset: sub === 'unset', layersBelow });
    print(written);
    return 0;
  }
  throw new UsageError('config show | config set <key> <value> | config unset <key>');
}

/** "codex's own default, gpt-5.1-codex (from ~/.codex/config.toml)" or the built-in default. */
function ownDefault(def, agent) {
  if (!def?.model) return `${agent}'s built-in default`;
  return `${agent}'s own default, ${def.model}${def.modelFrom ? ` (from ${def.modelFrom})` : ''}`;
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
    report.sessionsRequired = settings.sessions.required;
    report.executors = describeExecutors(settings, process.env, agentDefaults({ env: process.env, root: report.root })).map(entry =>
      entry.available ? { ...entry, version: versionOf(entry.foundAt ?? entry.command) } : entry,
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
    const mapping = Object.entries(report.mapping).map(([tier, executor]) => `${tier}->${executor}`).join(', ');
    lines.push(`configuration: ${report.config}`, `planner: ${report.planner}`, `profile: ${report.profile} (${mapping}; ${report.profileReason})`, 'executors:');
    for (const entry of report.executors) {
      const tiers = entry.tiers.length ? ` [${entry.tiers.join(', ')}]` : '';
      if (entry.reserved) lines.push(`  ${entry.id.padEnd(7)} reserved   ${entry.reason}${tiers}`);
      else if (entry.available) {
        const where = [entry.via === 'direct' ? null : entry.via, entry.discovered ? 'found outside PATH' : null].filter(Boolean).join(', ');
        lines.push(`  ${entry.id.padEnd(7)} available  ${entry.path}${where ? ` (${where})` : ''}${entry.version ? `  ${entry.version}` : ''}${tiers}`);
        lines.push(`          model: ${entry.model ?? ownDefault(entry.agentDefault, entry.id)}`);
      }
      else if (entry.problem) lines.push(`  ${entry.id.padEnd(7)} unusable   ${entry.problem}${tiers}`);
      else lines.push(`  ${entry.id.padEnd(7)} missing    "${entry.command}" is not on PATH${entry.command === entry.id ? ' or in its usual install folder' : ''}${tiers}`);
    }
  }
  if (!report.configError) lines.push(`planner sessions: ${report.sessionsRequired ? 'required' : 'not required'}`);
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

/** The waker of one planner Thread (wake.mjs); started by dispatch, not by hand. */
async function wake(thread) {
  if (!thread) throw new UsageError('Usage: agenthub-relay wake <thread>');
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  const root = process.env.AGENTHUB_RELAY_ROOT ?? process.cwd();
  const command = codexhostCommand(loadConfig({ root, env: process.env }), process.env);
  if (!command) throw Object.assign(new Error('No codexhost CLI to wake the planner with'), { code: 'executor-missing' });
  const stamp = () => new Date().toISOString();
  const outcome = await runWaker({
    root, thread, env: process.env, command, signal: controller.signal,
    // tests only: a shorter tick
    ...(Number(process.env.AGENTHUB_RELAY_WAKE_TICK_MS) > 0 ? { tickMs: Number(process.env.AGENTHUB_RELAY_WAKE_TICK_MS) } : {}),
    log: line => process.stdout.write(`${stamp()} ${line}\n`),
  });
  process.stdout.write(`${stamp()} waker for ${thread} stopped: ${outcome.stopped}${outcome.note ? ` (${outcome.note})` : ''}\n`);
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'wake':
      return wake(rest[0]);
    case 'mcp': {
      let client = 'unknown';
      const relay = createRelay({ cwd: process.cwd(), env: process.env, clientName: () => client });
      await serveMcp({ relay, onClient: info => (client = typeof info?.name === 'string' ? info.name : 'unknown') });
      return 0;
    }
    case 'agents':
      return tool(parse(rest, {}).values.planner, 'relay_agents', {});
    case 'session':
      return session(rest);
    case 'models':
      return models(rest);
    case 'dispatch':
      return dispatch(rest);
    case 'wait':
      return wait(rest);
    case 'result':
      return result(rest);
    case 'apply':
      return oneJob('relay_apply', rest, { 'allow-out-of-scope': { type: 'boolean' }, force: { type: 'boolean' } });
    case 'discard':
      return oneJob('relay_discard', rest, { force: { type: 'boolean' } });
    case 'cancel':
      return oneJob('relay_cancel', rest);
    case 'send':
      return send(rest);
    case 'takeover':
      return oneJob('relay_takeover', rest, { stop: { type: 'boolean' }, open: { type: 'boolean' } });
    case 'collect':
      return oneJob('relay_collect', rest, { session: { type: 'string' } });
    case 'install-skills':
      return installSkillsCommand(rest);
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
