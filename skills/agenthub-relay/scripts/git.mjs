// Git isolation: every job gets its own worktree and branch from a baseline
// snapshot; changes come back as a patch that the planner applies or discards.
// The main working tree is touched only by applyPatch().

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_UNTRACKED_LISTED = 20;
/** How often collecting changes is tried before a git failure is reported. */
export const COLLECT_ATTEMPTS = 3;
/** Failures worth another try: another git process holding a lock, or Windows sharing violations. */
const TRANSIENT_GIT = /index\.lock|\.lock': File exists|Unable to create .*\.lock|Permission denied|Device or resource busy|resource temporarily unavailable|being used by another process/i;
/**
 * Windows exit codes of a git that was stopped from outside rather than
 * failing: STATUS_CONTROL_C_EXIT (its console was closed or sent Ctrl+C) and
 * a forced termination. Seen when several jobs finished at once.
 */
const KILLED_EXIT_CODES = new Set([0xC000013A, 0x40010004, 0xC0000142]);

function fail(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runs git with arguments as an array (no shell). `env` adds variables for this
 * call only (GIT_INDEX_FILE, say); process.env is never changed.
 *
 * windowsHide matters more than its name says: a worker runs detached, with
 * no console of its own, so on Windows every git it starts would otherwise get
 * a new console window (handed to Windows Terminal on Windows 11), and closing
 * that console kills git mid-command with STATUS_CONTROL_C_EXIT.
 */
export function git(cwd, args, { allowFailure = false, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env ?? {}) } },
      (error, stdout, stderr) => {
        if (error && !allowFailure) {
          if (error.code === 'ENOENT') {
            reject(fail('git-missing', 'git is not installed or not on PATH'));
            return;
          }
          const how = [typeof error.code === 'number' ? `exit ${error.code}` : null, error.signal ? `signal ${error.signal}` : null].filter(Boolean).join(', ');
          reject(fail('git-failed', `git ${args[0]} failed${how ? ` (${how})` : ''}: ${(stderr || error.message).trim()}`, { stderr, exitCode: error.code, signal: error.signal }));
          return;
        }
        resolve({ stdout, stderr, code: error ? error.code : 0 });
      },
    );
  });
}

const zsplit = text => text.split('\0').filter(Boolean);

/** The top level of the repository containing `dir`. */
export async function repoRoot(dir) {
  const { stdout, code } = await git(dir, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (code !== 0) throw fail('not-a-git-repo', `${dir} is not inside a git repository`);
  return stdout.trim();
}

export function worktreePath(root, id) {
  return path.join(root, '.agenthub', 'worktrees', id);
}

export function branchName(id) {
  return `agenthub/${id}`;
}

/** Keeps .agenthub/ out of `git status` without touching tracked files. */
export async function ensureExcluded(root) {
  const { stdout } = await git(root, ['rev-parse', '--git-common-dir']);
  const common = path.resolve(root, stdout.trim());
  const exclude = path.join(common, 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!current.split(/\r?\n/).some(line => line.trim() === '.agenthub/')) {
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(exclude, `${prefix}# agenthub-relay runtime state\n.agenthub/\n`);
  }
}

/**
 * The commit a job starts from: HEAD, or a `git stash create` snapshot that
 * also holds uncommitted changes to tracked files. Untracked files are not in
 * either and are reported so the planner can decide.
 */
export async function snapshotBase(root) {
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  if (head.code !== 0) throw fail('no-commits', 'The repository has no commits yet; commit once before dispatching');
  const stash = await git(root, ['stash', 'create']);
  const snapshot = stash.stdout.trim();
  const { stdout } = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = zsplit(stdout).filter(file => !file.startsWith('.agenthub/'));
  return {
    commit: snapshot || head.stdout.trim(),
    head: head.stdout.trim(),
    includesUncommitted: snapshot !== '',
    untrackedCount: untracked.length,
    untracked: untracked.slice(0, MAX_UNTRACKED_LISTED),
  };
}

/** Creates the job's worktree and branch at the baseline commit. */
export async function addWorktree(root, id, commit) {
  const dir = worktreePath(root, id);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(root, ['worktree', 'add', '--quiet', '-b', branchName(id), dir, commit]);
  return { dir, branch: branchName(id) };
}

function removeQuietly(file) {
  for (const name of [file, `${file}.lock`]) {
    try {
      fs.unlinkSync(name);
    } catch {
      // never created, or already gone
    }
  }
}

async function collectOnce(worktree, base, indexDir) {
  // A private index: the worktree's own stays as the executor (or the person
  // who took the job over) left it, so a later turn's `git diff` still shows
  // its changes, and nothing here contends for the worktree's index.lock.
  // The file must not exist beforehand: git refuses an empty index file.
  const index = path.join(indexDir, `index.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(worktree, ['read-tree', 'HEAD'], { env });
    await git(worktree, ['add', '-A'], { env });
    const names = await git(worktree, ['diff', '--cached', '--name-only', '-z', '--no-renames', base], { env });
    const patch = await git(worktree, ['diff', '--cached', '--binary', '--no-renames', base], { env });
    const stat = await git(worktree, ['diff', '--cached', '--stat=200', '--no-renames', base], { env });
    return { files: zsplit(names.stdout), patch: patch.stdout, stat: stat.stdout.trim() };
  } finally {
    removeQuietly(index);
  }
}

/**
 * Everything changed in the job's worktree relative to the baseline: the file
 * list, a binary-safe patch and a stat summary. Collected through a temporary
 * index, so the worktree's own index is left alone. A failure that looks like
 * another git process holding a lock is tried again before it is reported.
 */
export async function collectChanges(worktree, base, { indexDir = os.tmpdir(), attempts = COLLECT_ATTEMPTS, delayMs = 1_000 } = {}) {
  fs.mkdirSync(indexDir, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await collectOnce(worktree, base, indexDir);
    } catch (err) {
      const transient = err.code === 'git-failed' && (TRANSIENT_GIT.test(`${err.stderr ?? ''} ${err.message}`) || KILLED_EXIT_CODES.has(err.exitCode) || Boolean(err.signal));
      if (!transient || attempt >= attempts) throw err;
      await sleep(delayMs * attempt);
    }
  }
}

/**
 * Whether the worktree is still on the job's branch with the baseline among
 * its ancestors; a checkout of another branch, a rebase or a reset elsewhere
 * would otherwise turn into a patch of unrelated history.
 */
export async function checkBranch(worktree, branch, base) {
  const head = await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
  const current = head.code === 0 ? head.stdout.trim() : null;
  if (current !== branch) {
    return { ok: false, reason: `the worktree is on ${current ? `branch ${current}` : 'a detached HEAD'}, not ${branch}` };
  }
  const ancestor = await git(worktree, ['merge-base', '--is-ancestor', base, 'HEAD'], { allowFailure: true });
  if (ancestor.code !== 0) return { ok: false, reason: `${branch} no longer contains the baseline commit ${base.slice(0, 12)}` };
  return { ok: true };
}

/** Applies a job's patch to the main working tree, after a dry run. */
export async function applyPatch(root, patchFile) {
  if (!fs.existsSync(patchFile) || fs.statSync(patchFile).size === 0) {
    throw fail('nothing-to-apply', 'The job changed nothing, so there is no patch to apply');
  }
  const check = await git(root, ['apply', '--check', '--whitespace=nowarn', patchFile], { allowFailure: true });
  if (check.code !== 0) {
    throw fail('apply-conflict', `The patch does not apply to the current working tree: ${check.stderr.trim()}`);
  }
  await git(root, ['apply', '--whitespace=nowarn', patchFile]);
}

/** Whether a patch is already wholly in the main working tree (it would apply in reverse). */
export async function patchIsApplied(root, patchFile) {
  if (!fs.existsSync(patchFile) || fs.statSync(patchFile).size === 0) return false;
  const reverse = await git(root, ['apply', '-R', '--check', '--whitespace=nowarn', patchFile], { allowFailure: true });
  return reverse.code === 0;
}

/** Removes the job's worktree and branch; missing pieces are fine. */
export async function removeWorktree(root, id) {
  const dir = worktreePath(root, id);
  if (fs.existsSync(dir)) {
    const removed = await git(root, ['worktree', 'remove', '--force', dir], { allowFailure: true });
    if (removed.code !== 0) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  await git(root, ['worktree', 'prune'], { allowFailure: true });
  await git(root, ['branch', '-D', branchName(id)], { allowFailure: true });
}
