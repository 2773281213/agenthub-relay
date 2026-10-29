// Shared test helpers: temporary git repositories, the fake executor and a
// configuration that points every executor at it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'src', 'cli.mjs');
export const FAKE_AGENT = path.join(ROOT, 'test', 'fixtures', 'fake-agent.mjs');

/** A fresh temporary directory, removed by the returned cleanup. */
export function tempDir(prefix = 'agenthub-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir: fs.realpathSync(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A git repository with one commit holding `files` ({ path: content }). */
export function makeRepo(files = { 'README.md': '# demo\n', 'src/app.txt': 'app\n', 'src/api/x.txt': 'x\n' }) {
  const { dir, cleanup } = tempDir('agenthub-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'agenthub test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return { dir, cleanup };
}

/** Makes sure the fake executor is runnable directly (its shebang). */
export function fakeAgent() {
  fs.chmodSync(FAKE_AGENT, 0o755);
  return FAKE_AGENT;
}

/**
 * Writes .agenthub/config.json so that codex, claude and dsh all run the fake
 * executor, which emulates each CLI's documented interface.
 */
export function useFakeExecutors(root, extra = {}) {
  const command = fakeAgent();
  const config = {
    executors: {
      codex: { command, ...(extra.codex ?? {}) },
      claude: { command, ...(extra.claude ?? {}) },
      dsh: { command, ...(extra.dsh ?? {}) },
    },
    ...(extra.top ?? {}),
  };
  fs.mkdirSync(path.join(root, '.agenthub'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agenthub', 'config.json'), JSON.stringify(config, null, 2));
  return config;
}

/** A task text the fake executor reads its instructions from. */
export function fakeTask(plan, prose = 'Do the thing.') {
  return `${prose}\nFAKE ${JSON.stringify(plan)}`;
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Polls `probe` until it returns a truthy value or the time runs out. */
export async function waitFor(probe, { timeoutMs = 20_000, intervalMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** Every file under a directory, recursively (for scanning stored records). */
export function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}
