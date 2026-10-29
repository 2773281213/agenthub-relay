// The skills as installers copy them: the agenthub-relay skill carries a
// generated copy of the hub that must match src/ and work on its own.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { fakeTask, makeRepo, ROOT, useFakeExecutors } from './helpers.mjs';

const SKILLS = path.join(ROOT, 'skills');
const COPY = path.join(SKILLS, 'agenthub-relay', 'scripts');

test("the skill's copy of the hub matches src/ byte for byte", () => {
  const sources = fs.readdirSync(path.join(ROOT, 'src')).filter(name => name.endsWith('.mjs')).sort();
  const copies = fs.readdirSync(COPY).filter(name => name.endsWith('.mjs')).sort();
  assert.deepEqual(copies, sources);
  for (const name of sources) {
    assert.ok(fs.readFileSync(path.join(COPY, name)).equals(fs.readFileSync(path.join(ROOT, 'src', name))), `${name} differs; run npm run bundle:skill`);
  }
  const check = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'bundle-skill.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('a copied skill directory runs the relay on its own', () => {
  const { dir, cleanup } = makeRepo();
  const installed = fs.mkdtempSync(path.join(path.dirname(dir), 'skill-install-'));
  try {
    useFakeExecutors(dir);
    // What `npx skills add` or a manual copy does: only the skill folder.
    fs.cpSync(path.join(SKILLS, 'agenthub-relay'), path.join(installed, 'agenthub-relay'), { recursive: true });
    const script = path.join(installed, 'agenthub-relay', 'scripts', 'cli.mjs');
    const env = { ...process.env, AGENTHUB_RELAY_ROOT: dir, AGENTHUB_RELAY_USER_CONFIG: path.join(installed, 'user.json') };
    delete env.AGENTHUB_RELAY_ROLE;
    delete env.CLAUDE_PROJECT_DIR;
    const run = (args, input) => {
      const out = spawnSync(process.execPath, [script, ...args], { cwd: dir, env, input, encoding: 'utf8' });
      return { code: out.status, json: out.stdout ? JSON.parse(out.stdout) : undefined, stderr: out.stderr };
    };
    const dispatched = run(['dispatch', '--tier', 'review', '--task-file', '-', '--planner', 'codex'], fakeTask({ message: 'looked around' }));
    assert.equal(dispatched.code, 0, dispatched.stderr);
    assert.equal(dispatched.json.executor, 'codex', "a Codex planner's review goes to Codex under codex-planner");
    let finished = [];
    for (let i = 0; i < 6 && finished.length === 0; i += 1) finished = run(['wait', dispatched.json.jobId, '--timeout', '20']).json.finished;
    assert.equal(finished[0]?.status, 'completed');
    assert.equal(run(['result', dispatched.json.jobId]).json.summary, 'looked around');
  } finally {
    cleanup();
    fs.rmSync(installed, { recursive: true, force: true });
  }
});
