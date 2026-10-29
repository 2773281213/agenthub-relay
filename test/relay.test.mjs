import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  addWorktree,
  applyPatch,
  branchName,
  collectChanges,
  ensureExcluded,
  removeWorktree,
  repoRoot,
  snapshotBase,
} from '../src/git.mjs';
import { git, makeRepo, tempDir } from './helpers.mjs';

describe('git isolation', () => {
  test('a clean tree starts from HEAD; uncommitted changes go into a snapshot, untracked files are reported', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, 'rev-parse', 'HEAD');
      const clean = await snapshotBase(dir);
      assert.equal(clean.commit, head);
      assert.equal(clean.includesUncommitted, false);
      assert.equal(clean.untrackedCount, 0);

      fs.writeFileSync(path.join(dir, 'src/app.txt'), 'app edited\n');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'untracked\n');
      const dirty = await snapshotBase(dir);
      assert.notEqual(dirty.commit, head);
      assert.equal(dirty.includesUncommitted, true);
      assert.deepEqual(dirty.untracked, ['notes.txt']);

      const { dir: wt } = await addWorktree(dir, 'j20261029-000000-aaaaaa', dirty.commit);
      assert.equal(fs.readFileSync(path.join(wt, 'src/app.txt'), 'utf8'), 'app edited\n');
      assert.equal(fs.existsSync(path.join(wt, 'notes.txt')), false);
      // Taking the snapshot leaves the main tree exactly as it was.
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'app edited\n');
      assert.match(git(dir, 'status', '--porcelain'), /src\/app\.txt/);
    } finally {
      cleanup();
    }
  });

  test('changes stay in the worktree until the patch is applied, then the worktree and branch are removed', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      await ensureExcluded(dir);
      await ensureExcluded(dir);
      const exclude = fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8');
      assert.equal(exclude.split('\n').filter(line => line === '.agenthub/').length, 1);

      const id = 'j20261029-000001-bbbbbb';
      const base = await snapshotBase(dir);
      const { dir: wt, branch } = await addWorktree(dir, id, base.commit);
      assert.equal(branch, branchName(id));
      assert.equal(git(dir, 'status', '--porcelain'), '', '.agenthub/ is excluded from status');

      fs.writeFileSync(path.join(wt, 'src/app.txt'), 'changed by executor\n');
      fs.mkdirSync(path.join(wt, 'src/new'), { recursive: true });
      fs.writeFileSync(path.join(wt, 'src/new/file.bin'), Buffer.from([0, 1, 2, 255]));
      fs.rmSync(path.join(wt, 'src/api/x.txt'));
      const changes = await collectChanges(wt, base.commit);
      assert.deepEqual(changes.files.sort(), ['src/api/x.txt', 'src/app.txt', 'src/new/file.bin']);
      assert.match(changes.stat, /3 files changed/);
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'app\n', 'main tree untouched');

      const patchFile = path.join(dir, '.agenthub', 'patch.diff');
      fs.writeFileSync(patchFile, changes.patch);
      await applyPatch(dir, patchFile);
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'changed by executor\n');
      assert.deepEqual([...fs.readFileSync(path.join(dir, 'src/new/file.bin'))], [0, 1, 2, 255]);
      assert.equal(fs.existsSync(path.join(dir, 'src/api/x.txt')), false);

      await removeWorktree(dir, id);
      assert.equal(fs.existsSync(wt), false);
      assert.equal(git(dir, 'branch', '--list', branch), '');
    } finally {
      cleanup();
    }
  });

  test('a patch that no longer applies is refused before anything changes', async () => {
    const { dir, cleanup } = makeRepo();
    try {
      const base = await snapshotBase(dir);
      const { dir: wt } = await addWorktree(dir, 'j20261029-000002-cccccc', base.commit);
      fs.writeFileSync(path.join(wt, 'src/app.txt'), 'executor version\n');
      const changes = await collectChanges(wt, base.commit);
      const patchFile = path.join(dir, '.agenthub', 'conflict.diff');
      fs.writeFileSync(patchFile, changes.patch);
      fs.writeFileSync(path.join(dir, 'src/app.txt'), 'planner version\n');
      await assert.rejects(applyPatch(dir, patchFile), err => err.code === 'apply-conflict');
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.txt'), 'utf8'), 'planner version\n');

      const empty = path.join(dir, '.agenthub', 'empty.diff');
      fs.writeFileSync(empty, '');
      await assert.rejects(applyPatch(dir, empty), err => err.code === 'nothing-to-apply');
    } finally {
      cleanup();
    }
  });

  test('a folder outside git, or a repository without commits, is refused', async () => {
    const outside = tempDir();
    const bare = tempDir();
    try {
      await assert.rejects(repoRoot(outside.dir), err => err.code === 'not-a-git-repo');
      git(bare.dir, 'init', '-q');
      await assert.rejects(snapshotBase(bare.dir), err => err.code === 'no-commits');
    } finally {
      outside.cleanup();
      bare.cleanup();
    }
  });
});
