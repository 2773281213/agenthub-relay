// Installing and updating the skill copies other agents load: ~/.claude/skills
// (Claude Code) and ~/.agents/skills (Codex and other agents that read the
// Agent Skills folder). Each installed skill folder gets a manifest with the
// digest of every file it was given, so an update can tell an untouched copy
// (replaced) from one a person changed (reported as a conflict, replaced only
// with --force after a backup). A copy from before manifests is recognized by
// the digests of every earlier release's files.
//
// Files are copied with readdir/copyFile: fs.cpSync aborts the process on
// some Windows setups when the source path has non-ASCII characters.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAMES = Object.freeze(['agenthub-relay', 'relay-config', 'relay-review', 'relay-status']);
export const MANIFEST = '.agenthub-relay-managed.json';

/**
 * sha256 of the LF-normalized content of every file of every earlier release
 * (each version under skills/ in this repository's history up to 0.4.0).
 */
export const RELEASED_DIGESTS = Object.freeze({
  'agenthub-relay/SKILL.md': ['11aa64827b253464d9d9b5e91e04f072ef44455a7482dbd4d08ecdb934e3c163', '537a725362d442433b1ca69a68b40ee11b59d46f6e09eb957910295173630ea8', '7ed6c04f2698b45425771dc0d1a16e8a5c9bb836e38ba6ea65da5bd803731ebd', '8abe42c5aaf5cf0db58fa103e4669df3babc4eb3a958663254e378f658e508bb', '9376d574d9084894b5a7ef19f96c0465383c54f7e13252a282e0a4f19a31054d', 'ecddf96e4ce945d243be3e6b6f17e3c261dde4e65e0b1fc7a130ff298b0ca783'],
  'agenthub-relay/scripts/checks.mjs': ['13b2e97af021e66c22cb2eebf827b11be42829c3ef0f9296e9ac272b752602e3', 'ba9382afa92c34d3929f8ab7e1881bf356290e54f403149d71beaba85e71220b'],
  'agenthub-relay/scripts/cli.mjs': ['5dd09b52324bd3d757e560006a4c9bb1471016e2a4f46c8e3b7af9643dd34145', '789326ab6132c4255e8a4b53cb9d0f6da9cf870d49d00e849682c9ead364c7ff', 'a177eae5d32c80841d1a9a564a10d0092b6c5bcfc58e8f216fbbf1fe9f4b0053', 'd011d9577cef44d712d9f5f6543dc4589f6e1ede630b5439ad21daeb59e6900a', 'df281914a1fc6368d31cee79183ab2790eeaf764ae43d3bb73ce607e39d1582f'],
  'agenthub-relay/scripts/config.mjs': ['14a318026bb7127ebb47c452b8a0a5fe7b6ee74e98dc1cfc9ff346f29f24c832', '937ec744156d615377f1dab45dc15575d621797c6da16fe9a5f86b14f66a6933', 'b1a167b3008f352c40c8e2192c58128b1a5743529bee2fe5e1fdc688d69b7ef0', 'e57dde1e55bd6c6008a185fe50f8f0b336126b5e06b472d491fe7741cbf3fc98', 'ff19efc992c85737329de25c39c7fd0efe5d496ceb0905dc6bb2a7ddf6d12809'],
  'agenthub-relay/scripts/executors.mjs': ['0f2c77d5861413a5912098e1e089323d5ce13bede957ba9585548e40d2dd4995', '1659ab697ad4f0e3543ef7649acae9c96795eb75d72a01934826c83b1302d948', '209695fedec605a1045e259db5c3c360e43bb66a81ac73b7cc8585d4a4bcf159', 'ae2f13d542cad6744fd4254667f6eb19eefb8e223cd3e0e1a46d2233f790ba15', 'f7b81f32d36aea73cbf7bb7c3bb09873646ba8f6bac08bc9f96f1873b8549523'],
  'agenthub-relay/scripts/git.mjs': ['acdb8d504041c1f915e8736d6a055df7cee5482891ac14b4e658aa91f1beb877'],
  'agenthub-relay/scripts/mcp.mjs': ['3a89bd23a5ed95f9598d5d78c5bb4db272927ed6610f9e56feed1cac15ec8894', 'dd0ad4e692e82d9d45c083b4d22283536e144ca0a24e71d64c929999e9a96c53'],
  'agenthub-relay/scripts/models.mjs': ['802f61ff6b01cca774bc2022868646e15ff8391ea9580cbf4cb6a7eef92314b7', 'c789789343a8be6f305fa7e2c8fc5ed0905cae9e3f385c8f0f029b2fa7eed692'],
  'agenthub-relay/scripts/platform.mjs': ['7ea3223685c3ac0a95016137fb391769b5ef4a7917fb59aadc5d853a79732aa2', 'e0834c00c99230fdd8d8193301d3eee768f769f50041a7eab053b4d67c54e0a2'],
  'agenthub-relay/scripts/policy.mjs': ['17de1784371911a7b155bd7cb72b0b5739c2de6a4aa10d8d173828ffe4b548eb', 'fb4c8652215ef91c61dc1d3d26173feeeb790232606956bf82c6b0dcb0017524'],
  'agenthub-relay/scripts/session.mjs': ['b18d880909a8f104f24e129954213c03b9126ee2b0b930e85daae45066beaafe'],
  'agenthub-relay/scripts/store.mjs': ['c2684f0475f855abd4adee7915a62365cdb21b91493e22ae7accceb68a73c443', 'f2332702bb5e70bc041edfa3c154ca1955a531701c02baacb7226626afbf69a1'],
  'agenthub-relay/scripts/tools.mjs': ['25320e03051c032073aa39f937fe30409c3114c792cf896cdf9715accda12440', '25410d37dfea43435cb17f78832cc1c71d2268e3dc93696bac20a7442bced6a6', '32cdbf4ea857fb51dcaad7af2a430319d5d3eca94bcb317c7874b4e92c18f04d', 'dd322f3721697ca68e9ceabdced0ca11a05fed3ddc30cc32115ad2197f75b0b8', 'e1120b050663ebc42df31f174a4896bf59fee2ccd9dfc6c1e5a7d9aa11500e7b'],
  'agenthub-relay/scripts/worker.mjs': ['78370559327607059324ec0c50726f03ed6ba1ee8539957b061b0b8c11f422cd', '8d09b2e5db5dfac340aa0db2b916af16b0499fe43a67b7930954692ecf278797', '9eb5c8afd41344ff19375a75fb45b8d74fe081dc0def259ab85443e055165b9e', 'e1e067d13c68a0c1b390e98ad6476ecc725d6f256bc6fe032b15f903b48b4fed'],
  'agenthub-relay/scripts/yaml-lite.mjs': ['eabfb286c7253334b57deb949839674675de243b8bc8e2353ac69c37a09be99e'],
  'relay-config/SKILL.md': ['2acfc78a1156a947fa288845c45f554780d952870d4afc99865902bacf9185ac', '8a9dde96092aa05aa47a1d94f62a28d3bdfb970f041327f3bbb3181a93d4868c'],
  'relay-review/SKILL.md': ['cdccd79615f303f8c85b6acb150acb8ea90e7cea9ef2e16b1b38247544ae1957', 'ce1c6b6c03907f28ca30ca040cbbee4a3b5b7d9d8080af8bbb3f32ae835e70b6'],
  'relay-status/SKILL.md': ['b2b145115962ea068d829fe7c42c5f8ffafd94f9b87f7b9a782f8d191d672d25'],
});

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** sha256 of a file's content with CRLF read as LF, so a checkout's line endings do not count as an edit. */
export function digestOf(buffer) {
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Every file under `dir`, as forward-slash paths relative to it, without the manifest. */
export function listTree(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(dir, rel));
    else if (entry.isFile() && rel !== MANIFEST) out.push(rel);
  }
  return out.sort();
}

function digests(dir, files) {
  return Object.fromEntries(files.map(file => [file, digestOf(fs.readFileSync(path.join(dir, ...file.split('/'))))]));
}

/** Copies a folder tree without fs.cpSync (see the file comment). */
export function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(a, b);
    else if (entry.isFile()) fs.copyFileSync(a, b);
  }
}

function readManifest(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeManifest(dir, { version, files, now }) {
  const manifest = { managedBy: 'agenthub-relay', version, installedAt: now.toISOString(), files };
  fs.writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The skills folder this installation was loaded from: skills/ next to src/
 * in the repository or plugin, or the folder that holds an installed skill
 * whose scripts/ this module is in.
 */
export function skillSource(here = path.dirname(fileURLToPath(import.meta.url))) {
  for (const candidate of [path.join(here, '..', 'skills'), path.join(here, '..', '..')]) {
    if (fs.existsSync(path.join(candidate, 'agenthub-relay', 'SKILL.md'))) return path.resolve(candidate);
  }
  throw fail('no-skill-source', `No agenthub-relay skill folder next to ${here}`);
}

/** The skill folders of Claude Code and of the Agent Skills convention, under the home of `env`. */
export function skillTargets(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return { claude: path.join(claudeDir, 'skills'), agents: path.join(home, '.agents', 'skills') };
}

function sameFiles(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function installOne(skill, from, to, { force, dryRun, version, now, released }) {
  const wantedFiles = listTree(from);
  const wanted = digests(from, wantedFiles);
  if (!fs.existsSync(to)) {
    if (!dryRun) {
      copyTree(from, to);
      writeManifest(to, { version, files: wanted, now });
    }
    return { status: dryRun ? 'would-install' : 'installed' };
  }
  const presentFiles = listTree(to);
  const present = digests(to, presentFiles);
  const manifest = readManifest(to);
  if (sameFiles(present, wanted)) {
    if (!dryRun && (manifest?.version !== version || !sameFiles(manifest.files, wanted))) writeManifest(to, { version, files: wanted, now });
    return { status: 'current' };
  }
  // What a person changed: against the manifest when there is one, otherwise
  // anything that matches no released version of that file.
  const changed = manifest
    ? [
        ...presentFiles.filter(file => manifest.files[file] !== present[file]),
        ...Object.keys(manifest.files).filter(file => present[file] === undefined).map(file => `${file} (deleted)`),
      ]
    : presentFiles.filter(file => !(released[`${skill}/${file}`] ?? []).includes(present[file]));
  if (changed.length && !force) return { status: 'conflict', changed };
  if (dryRun) return { status: changed.length ? 'would-replace' : 'would-update', ...(changed.length ? { changed } : {}) };
  let backup;
  if (changed.length) {
    // Beside the skills folder, not in it: agents load every folder in there as a skill.
    const skillsDir = path.dirname(to);
    backup = path.join(path.dirname(skillsDir), `${path.basename(skillsDir)}-backups`, `${skill}-${stamp(now)}`);
    copyTree(to, backup);
  }
  for (const file of presentFiles) {
    if (wanted[file] === undefined) fs.unlinkSync(path.join(to, ...file.split('/')));
  }
  copyTree(from, to);
  writeManifest(to, { version, files: wanted, now });
  return { status: 'updated', ...(backup ? { backup, changed } : {}) };
}

/**
 * Installs or updates every skill of `source` in each target folder and says
 * what became of each: installed, updated, current, or conflict (the files a
 * person changed; nothing is written). force replaces a changed copy after
 * backing it up beside itself; dryRun only reports.
 */
export function installSkills({
  source = skillSource(), targets = skillTargets(), force = false, dryRun = false, version, now = new Date(), released = RELEASED_DIGESTS,
} = {}) {
  const results = [];
  for (const [target, dir] of Object.entries(targets)) {
    for (const skill of SKILL_NAMES) {
      const from = path.join(source, skill);
      const to = path.join(dir, skill);
      if (!fs.existsSync(path.join(from, 'SKILL.md'))) {
        results.push({ target, skill, path: to, status: 'no-source' });
        continue;
      }
      results.push({ target, skill, path: to, ...installOne(skill, from, to, { force, dryRun, version, now, released }) });
    }
  }
  return results;
}
