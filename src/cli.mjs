#!/usr/bin/env node
// agenthub-relay command line:
//   mcp            serve the relay_* tools over stdio (what planners load)
//   worker <id>    run one job (started detached by relay_dispatch)
//   doctor         show the repository, profile and which executors are installed
//   status         list jobs

import { spawnSync } from 'node:child_process';

import { loadConfig } from './config.mjs';
import { describeExecutors } from './executors.mjs';
import { serveMcp } from './mcp.mjs';
import { createStore, TERMINAL } from './store.mjs';
import { createRelay, resolveRoot, VERSION } from './tools.mjs';
import { runWorker } from './worker.mjs';

const HELP = `agenthub-relay ${VERSION}

Usage:
  agenthub-relay mcp            Serve the relay_* tools over stdio for any MCP client
  agenthub-relay doctor [--json] Show the repository, profile and installed executors
  agenthub-relay status [--json] List jobs in this repository
  agenthub-relay worker <jobId> Run one job (relay_dispatch starts this for you)
  agenthub-relay --version

Environment:
  AGENTHUB_RELAY_ROOT     repository to serve (default: CLAUDE_PROJECT_DIR, then the working directory)
  AGENTHUB_RELAY_CONFIG   configuration file (default: <root>/.agenthub/config.json)
  AGENTHUB_RELAY_PROFILE  profile to use (default: thread16)
`;

function versionOf(path) {
  const run = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error || run.status !== 0) return undefined;
  return run.stdout.trim().split('\n')[0] || undefined;
}

async function doctor(json) {
  const report = { version: VERSION, node: process.version };
  try {
    report.root = await resolveRoot(process.cwd(), process.env);
  } catch (err) {
    report.rootError = err.message;
  }
  try {
    const config = loadConfig({ root: report.root, env: process.env });
    report.config = config.source ?? 'built-in defaults';
    report.profile = config.profile;
    report.mapping = config.mapping;
    report.executors = describeExecutors(config, process.env).map(entry =>
      entry.available ? { ...entry, version: versionOf(entry.path) } : entry,
    );
  } catch (err) {
    report.configError = err.message;
  }
  report.promptCacheTtl = process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null;
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const lines = [`agenthub-relay ${VERSION} on Node ${process.version}`];
  lines.push(report.root ? `repository: ${report.root}` : `repository: none (${report.rootError})`);
  if (report.configError) {
    lines.push(`configuration error: ${report.configError}`);
  } else {
    const mapping = Object.entries(report.mapping).map(([tier, executor]) => `${tier}→${executor}`).join(', ');
    lines.push(`configuration: ${report.config}`, `profile: ${report.profile} (${mapping})`, 'executors:');
    for (const entry of report.executors) {
      const tiers = entry.tiers.length ? ` [${entry.tiers.join(', ')}]` : '';
      if (entry.reserved) lines.push(`  ${entry.id.padEnd(7)} reserved   ${entry.reason}${tiers}`);
      else if (entry.available) lines.push(`  ${entry.id.padEnd(7)} available  ${entry.path}${entry.version ? `  ${entry.version}` : ''}${tiers}`);
      else lines.push(`  ${entry.id.padEnd(7)} missing    "${entry.command}" is not on PATH${tiers}`);
    }
  }
  lines.push(`CLAUDE_CODE_PROMPT_CACHE_TTL: ${report.promptCacheTtl ?? 'unset (Claude Code default for your account)'}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function status(json) {
  const root = await resolveRoot(process.cwd(), process.env);
  const store = createStore(root);
  const jobs = await Promise.all(store.list().map(job => store.reconcile(job)));
  if (json) {
    process.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
    return 0;
  }
  if (jobs.length === 0) {
    process.stdout.write('No jobs in this repository.\n');
    return 0;
  }
  for (const job of jobs) {
    const state = TERMINAL.has(job.status) ? `${job.status}/${job.integration}` : job.status;
    process.stdout.write(`${job.id}  ${state.padEnd(20)} ${`${job.tier}→${job.executor}`.padEnd(14)} ${job.verification ?? ''}  ${job.title}\n`);
  }
  return 0;
}

async function worker(jobId) {
  if (!jobId) throw Object.assign(new Error('Usage: agenthub-relay worker <jobId>'), { code: 'usage' });
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
    case 'worker':
      return worker(rest[0]);
    case 'doctor':
      return doctor(rest.includes('--json'));
    case 'status':
      return status(rest.includes('--json'));
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
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  err => {
    process.stderr.write(`agenthub-relay: ${err.message}\n`);
    process.exitCode = 1;
  },
);
