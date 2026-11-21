// Finding executors outside PATH, and the installer of skill copies.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { clearDiscoveryCache, codexPackageRoots, executorCommand, installCandidates, locateExecutor } from '../src/discovery.mjs';
import { describeExecutors } from '../src/executors.mjs';
import { digestOf, installSkills, MANIFEST, RELEASED_DIGESTS, SKILL_NAMES } from '../src/install.mjs';
import { ROOT, tempDir } from './helpers.mjs';

const windows = process.platform === 'win32';

/** A home folder with agy installed where its installer puts it, and an empty PATH. */
function homeWithAgy(dir) {
  const env = { PATH: path.join(dir, 'empty-bin'), HOME: dir, USERPROFILE: dir, LOCALAPPDATA: path.join(dir, 'AppData', 'Local') };
  fs.mkdirSync(env.PATH, { recursive: true });
  const agy = windows ? path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : path.join(dir, '.local', 'bin', 'agy');
  fs.mkdirSync(path.dirname(agy), { recursive: true });
  fs.writeFileSync(agy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { env, agy };
}

test('the default command not on PATH is found in its install folder; a configured command is never replaced', () => {
  const { dir, cleanup } = tempDir();
  try {
    clearDiscoveryCache();
    const { env, agy } = homeWithAgy(dir);
    const found = locateExecutor('agy', 'agy', { env, spawnSync: () => ({ status: 1 }) });
    assert.equal(found.discovered, true);
    assert.equal(found.command, agy);
    assert.equal(found.resolved.path, agy);
    assert.equal(executorCommand('agy', loadConfig({ env: {} }), { env, spawnSync: () => ({ status: 1 }) }), agy);

    const configured = locateExecutor('agy', path.join(dir, 'my-agy'), { env });
    assert.deepEqual([configured.discovered, configured.resolved], [false, null], 'no silent fallback from a configured command');
    clearDiscoveryCache();
    assert.equal(locateExecutor('agy', 'agy', { env: { ...env, AGENTHUB_RELAY_DISCOVERY: 'off' } }).resolved, null);
    assert.deepEqual(installCandidates('agy', { env: { PATH: '' } }), [], 'no home in the environment, nothing searched');

    clearDiscoveryCache();
    const listed = describeExecutors(loadConfig({ env: {} }), env).find(entry => entry.id === 'agy');
    assert.equal(listed.available, true);
    assert.equal(listed.discovered, true);
    assert.equal(listed.foundAt, agy);
  } finally {
    clearDiscoveryCache();
    cleanup();
  }
});

test("Codex Desktop's package folder comes from the registry (reg.exe query output)", () => {
  const calls = [];
  const spawnSync = (file, args) => {
    calls.push([file, ...args]);
    if (args.includes('/k')) {
      return {
        status: 0,
        stdout: '\r\nHKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\OpenAI.Codex_26.1117.3838.0_x64__2p2nqsd0c76g0\r\nEnd of search: 1 match(es) found.\r\n',
      };
    }
    return { status: 0, stdout: '\r\nHKEY_CURRENT_USER\\...\r\n    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.3838.0_x64__2p2nqsd0c76g0\r\n\r\n' };
  };
  assert.deepEqual(codexPackageRoots({ spawnSync }), ['C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.3838.0_x64__2p2nqsd0c76g0']);
  assert.equal(calls[0][0], 'reg');
  assert.deepEqual(codexPackageRoots({ spawnSync: () => ({ status: 1, stdout: '' }) }), []);
  const candidates = installCandidates('codex', { env: { USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\nowhere' }, platform: 'win32', spawnSync });
  assert.equal(candidates[0], path.join('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.3838.0_x64__2p2nqsd0c76g0', 'app', 'resources', 'codex.exe'));
});

function skillsSource(dir) {
  const source = path.join(dir, 'source');
  for (const name of SKILL_NAMES) {
    fs.mkdirSync(path.join(source, name, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(source, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  fs.writeFileSync(path.join(source, 'agenthub-relay', 'scripts', 'cli.mjs'), '// new\n');
  return source;
}

test('install-skills installs, keeps a current copy, reports a changed one, and replaces it only with force after a backup', () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = skillsSource(dir);
    const targets = { claude: path.join(dir, 'claude-skills'), agents: path.join(dir, 'agents-skills') };
    const now = new Date(Date.UTC(2026, 10, 21, 8, 0, 0));
    const first = installSkills({ source, targets, version: '9.9.9', now });
    assert.deepEqual([...new Set(first.map(entry => entry.status))], ['installed']);
    const installed = path.join(targets.claude, 'agenthub-relay');
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, MANIFEST), 'utf8'));
    assert.equal(manifest.version, '9.9.9');
    assert.equal(manifest.files['scripts/cli.mjs'], digestOf(Buffer.from('// new\n')));
    assert.deepEqual([...new Set(installSkills({ source, targets, version: '9.9.9', now }).map(entry => entry.status))], ['current']);

    // CRLF line endings are not an edit.
    fs.writeFileSync(path.join(installed, 'scripts', 'cli.mjs'), '// new\r\n');
    assert.equal(installSkills({ source, targets: { claude: targets.claude }, version: '9.9.9', now })[0].status, 'current');

    fs.writeFileSync(path.join(installed, 'scripts', 'cli.mjs'), '// my local fix\n');
    fs.writeFileSync(path.join(source, 'agenthub-relay', 'scripts', 'cli.mjs'), '// newer\n');
    const conflict = installSkills({ source, targets: { claude: targets.claude }, version: '9.9.10', now })[0];
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(conflict.changed, ['scripts/cli.mjs']);
    assert.equal(fs.readFileSync(path.join(installed, 'scripts', 'cli.mjs'), 'utf8'), '// my local fix\n', 'nothing written');
    assert.equal(installSkills({ source, targets: { claude: targets.claude }, version: '9.9.10', now, dryRun: true })[0].status, 'conflict');
    assert.equal(installSkills({ source, targets: { claude: targets.claude }, version: '9.9.10', now, dryRun: true, force: true })[0].status, 'would-replace');

    const forced = installSkills({ source, targets: { claude: targets.claude }, version: '9.9.10', now, force: true })[0];
    assert.equal(forced.status, 'updated');
    assert.equal(fs.readFileSync(path.join(forced.backup, 'scripts', 'cli.mjs'), 'utf8'), '// my local fix\n', 'the changed copy is kept beside it');
    assert.equal(fs.readFileSync(path.join(installed, 'scripts', 'cli.mjs'), 'utf8'), '// newer\n');

    // Untouched copies are updated without force.
    assert.equal(installSkills({ source, targets: { agents: targets.agents }, version: '9.9.10', now })[0].status, 'updated');
  } finally {
    cleanup();
  }
});

test('a copy from before manifests is updated when every file is a released version, and reported when it is not', () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = skillsSource(dir);
    const target = path.join(dir, 'skills');
    const released = { 'relay-status/SKILL.md': [digestOf(Buffer.from('as released\n'))] };
    fs.mkdirSync(path.join(target, 'relay-status'), { recursive: true });
    fs.writeFileSync(path.join(target, 'relay-status', 'SKILL.md'), 'as released\r\n');
    fs.mkdirSync(path.join(target, 'relay-review'), { recursive: true });
    fs.writeFileSync(path.join(target, 'relay-review', 'SKILL.md'), 'hand-written\n');
    fs.writeFileSync(path.join(target, 'relay-review', 'notes.bak'), 'mine\n');
    const results = installSkills({ source, targets: { claude: target }, version: '0.5.0', released });
    assert.equal(results.find(entry => entry.skill === 'relay-status').status, 'updated');
    assert.match(fs.readFileSync(path.join(target, 'relay-status', MANIFEST), 'utf8'), /"version": "0\.5\.0"/);
    const review = results.find(entry => entry.skill === 'relay-review');
    assert.equal(review.status, 'conflict');
    assert.deepEqual(review.changed.sort(), ['SKILL.md', 'notes.bak']);
    // Every file of this repository's earlier releases is listed.
    for (const name of SKILL_NAMES) assert.ok(RELEASED_DIGESTS[`${name}/SKILL.md`]?.length, `${name} has released digests`);
    assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'agenthub-relay', 'SKILL.md')));
  } finally {
    cleanup();
  }
});
