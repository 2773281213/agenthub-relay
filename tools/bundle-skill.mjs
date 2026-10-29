#!/usr/bin/env node
// Copies the hub (src/*.mjs) into skills/agenthub-relay/scripts/, so the skill
// directory works on its own when a skill installer copies only that folder.
// src/ is the source; the copy is generated and never edited by hand.
//
//   node tools/bundle-skill.mjs          write the copy
//   node tools/bundle-skill.mjs --check  exit 1 if the copy differs from src/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src');
const target = path.join(root, 'skills', 'agenthub-relay', 'scripts');
const check = process.argv.includes('--check');

const wanted = fs.readdirSync(source).filter(name => name.endsWith('.mjs')).sort();
const present = fs.existsSync(target) ? fs.readdirSync(target).filter(name => name.endsWith('.mjs')).sort() : [];
const problems = [];

for (const name of wanted) {
  const from = path.join(source, name);
  const to = path.join(target, name);
  const same = fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from));
  if (same) continue;
  if (check) {
    problems.push(`${path.relative(root, to)} differs from ${path.relative(root, from)}`);
    continue;
  }
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, fs.statSync(from).mode & 0o777);
}
for (const name of present.filter(name => !wanted.includes(name))) {
  if (check) problems.push(`${path.relative(root, path.join(target, name))} has no source in src/`);
  else fs.rmSync(path.join(target, name));
}

if (check && problems.length) {
  process.stderr.write(`The skill's copy of the hub is out of date; run npm run bundle:skill.\n${problems.map(p => `  ${p}`).join('\n')}\n`);
  process.exitCode = 1;
} else if (!check) {
  process.stdout.write(`Copied ${wanted.length} files from src/ to ${path.relative(root, target)}/\n`);
}
