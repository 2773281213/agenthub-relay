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

function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${file} starts with frontmatter`);
  return { fields: Object.fromEntries(match[1].split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()])), body: text.slice(match[0].length) };
}

test('each skill is named after its folder; the thin entries are explicit-only and find the script', () => {
  const names = fs.readdirSync(SKILLS).filter(name => fs.existsSync(path.join(SKILLS, name, 'SKILL.md'))).sort();
  assert.deepEqual(names, ['agenthub-relay', 'relay-config', 'relay-review', 'relay-status']);
  for (const name of names) {
    const { fields, body } = frontmatter(path.join(SKILLS, name, 'SKILL.md'));
    assert.equal(fields.name, name);
    assert.ok(fields.description.length > 40 && fields.description.length <= 1024, `${name} has a usable description`);
    if (name === 'agenthub-relay') {
      assert.equal(fields['disable-model-invocation'], undefined, 'the main skill may be chosen by the model');
      continue;
    }
    assert.equal(fields['disable-model-invocation'], 'true', `${name} runs only when invoked`);
    assert.match(fields.description, new RegExp(`Use only when the user invokes ${name}`));
    const script = /node (\.\.\/agenthub-relay\/scripts\/cli\.mjs)/.exec(body)?.[1];
    assert.ok(script, `${name} names the relay script`);
    assert.ok(fs.existsSync(path.join(SKILLS, name, script)), `${name}: ${script} exists`);
  }
});
