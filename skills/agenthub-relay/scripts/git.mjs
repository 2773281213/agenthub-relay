// Git isolation: every job gets its own worktree and branch from a baseline
// snapshot; changes come back as a patch that the planner applies or discards.
// The main working tree is touched only by applyPatch().

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_UNTRACKED_LISTED = 20;

function fail(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra);
}

/** Runs git with arguments as an array (no shell). */
export function git(cwd, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        if (error && !allowFailure) {
          if (error.code === 'ENOENT') {
            reject(fail('git-missing', 'git is not installed or not on PATH'));
            return;
          }
          reject(fail('git-failed', `git ${args[0]} failed: ${(stderr || error.message).trim()}`, { stderr }));
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
  if (!current.split('\n').some(line => line.trim() === '.agenthub/')) {
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

/**
 * Everything the executor changed relative to the baseline, staged in the
 * job's own worktree: the file list, a binary-safe patch and a stat summary.
 */
export async function collectChanges(worktree, base) {
  await git(worktree, ['add', '-A']);
  const names = await git(worktree, ['diff', '--cached', '--name-only', '-z', '--no-renames', base]);
  const patch = await git(worktree, ['diff', '--cached', '--binary', '--no-renames', base]);
  const stat = await git(worktree, ['diff', '--cached', '--stat=200', '--no-renames', base]);
  return { files: zsplit(names.stdout), patch: patch.stdout, stat: stat.stdout.trim() };
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

/** Removes the job's worktree and branch; missing pieces are fine. */
export async function removeWorktree(root, id) {
  const dir = worktreePath(root, id);
  if (fs.existsSync(dir)) {
    const removed = await git(root, ['worktree', 'remove', '--force', dir], { allowFailure: true });
    if (removed.code !== 0) fs.rmSync(dir, { recursive: true, force: true });
  }
  await git(root, ['worktree', 'prune'], { allowFailure: true });
  await git(root, ['branch', '-D', branchName(id)], { allowFailure: true });
}
