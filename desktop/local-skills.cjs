// Local skills store — the storage behind Customize > Skills.
//
// The page has a complete UI (Add skill / Upload / Create, list, toggle, rename,
// delete, reveal) and the bridge declares nine LocalAgentModeSessions skill methods,
// but NONE of them had a handler. Every call fell through to the generic fallback,
// which answers null for save/rename/delete and [] for list/getLocalSkillFiles.
//
// Measured on the live replica before this file existed:
//   listLocalSkills()                  -> []          (page: "Add your first skills")
//   saveLocalSkill(name, desc, md)     -> null        (the Create dialog could not save)
//   setLocalSkillEnabled / rename / delete -> null    (ok === undefined -> the UI throws)
//
// So a user could fill in the Create dialog, press Save, and nothing was written
// anywhere — the list simply reloaded empty. This is the same "called but unhandled"
// defect class as listSessionDirectory (round 43) and provider configs (round 71):
// the method *exists* on the preload object, so every capability check in the UI
// passes, and the silence only shows up as a feature that does not work.
//
// Shape contracts (verified against the shipped bundle, index.chunk-lzaSYO3Q.js):
//   listLocalSkills            -> array of {skillId, name, description, enabled, updatedAt?}
//                                 validator dCt: all three strings + boolean enabled
//   getLocalSkillFiles         -> array of {path, content}   (consumer: {files: await ...})
//   saveLocalSkill             -> {ok, skillId} / {ok:false, error, isUserFacingError}
//                                 validator fCt; error "already_exists" has its own branch
//   saveLocalSkillArchive      -> same, plus optional leftOutFileCount (validator pCt)
//   renameLocalSkill /
//   setLocalSkillEnabled /
//   deleteLocalSkill           -> {ok, skillId?} (validator fCt)
//
// Storage layout (inside the writable data directory — Electron's main process gets
// EPERM outside the workspace on this host, see tools/probe-store-write.cjs):
//
//   <dataDir>/skills/_skills.json      { skills: { "<id>": { enabled, updatedAt } } }
//   <dataDir>/skills/<id>/SKILL.md     the skill itself (YAML front matter + body)
//   <dataDir>/skills/<id>/...          any other files the skill ships
//
// Listing is derived from the DIRECTORY, not from the index, so a folder dropped in by
// hand still shows up; the index only carries the mutable bits (enabled, updatedAt).
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const MAX_NAME = 100;
const MAX_SKILL_MD_BYTES = 1024 * 1024;
const MAX_FILES = 200;
const MAX_PER_FILE_BYTES = 512 * 1024;
const INDEX_FILE = '_skills.json';

/** Names the frontend refuses with its own "reserved skill name" error. */
const RESERVED = new Set(['skill', 'skills', 'plugin', 'plugins', 'anthropic', 'claude']);

/**
 * Windows device names. A directory called `CON` (or `nul`, `com1`...) is not an
 * ordinary directory: every legacy path API still resolves it to the device, so
 * Explorer, robocopy and most backup tools fail on the whole tree around it. Node's own
 * `\?`-prefixed calls do create it (measured: the directory really appears on disk),
 * which is exactly why the guard has to live here rather than be assumed. These names
 * are refused on every platform so the store stays portable anywhere.
 */
const DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const skillsRoot = (dataDir) => path.join(dataDir, 'skills');
const indexFile = (dataDir) => path.join(skillsRoot(dataDir), INDEX_FILE);

function readIndex(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(dataDir), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.skills && typeof parsed.skills === 'object'
      ? parsed
      : { skills: {} };
  } catch {
    return { skills: {} };
  }
}

/** Atomic write, so a crash mid-save cannot leave a truncated index. */
function writeIndex(dataDir, index) {
  const file = indexFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Parse the YAML front matter the app writes. Only `name` and `description` are read:
 * those are the two fields every consumer renders, and the shipped app's own reader
 * (shared-104-BCGAQIp5.js, `WP`) rejects a manifest missing either.
 *
 * @param {string} text SKILL.md contents
 * @returns {{name?: string, description?: string}|null}
 */
function parseFrontmatter(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const m = /(?:^|\r?\n)---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key !== 'name' && key !== 'description') continue;
    let value = kv[2].trim();
    // Quoted scalars drop their quotes; everything else is taken verbatim.
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value) || /^'((?:[^']|'')*)'/.exec(value);
    if (quoted) value = quoted[1].replace(/""/g, "'").replace(/\\"/g, '"');
    out[key] = value;
  }
  return out;
}

/**
 * True when a name can be a skill directory. Rejects anything that could escape the
 * store, plus the names the app treats as reserved.
 *
 * @param {unknown} name
 * @returns {string|null} the reason it is refused, or null when it is acceptable
 */
function nameProblem(name) {
  if (typeof name !== 'string' || !name.trim()) return 'A skill needs a name.';
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME) return 'That name is too long.';
  if (/[\u0000-\u001f<>:"/\\|?*]/.test(trimmed) || trimmed.includes('..') || trimmed.startsWith('.')) {
    return 'Use letters, numbers, spaces, dashes and underscores.';
  }
  if (RESERVED.has(trimmed.toLowerCase())) return `'${trimmed}' is a reserved skill name`;
  if (DEVICE_NAMES.test(trimmed)) return `'${trimmed}' is a reserved device name on Windows.`;
  return null;
}

/** A cheap stable id for a skill: the directory name, as the shipped app uses. */
const skillIdOf = (name) => String(name).trim();

/** Directory names that exist under the store, oldest first is not guaranteed. */
function skillDirs(dataDir) {
  let names;
  try {
    names = fs.readdirSync(skillsRoot(dataDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The skills the installed app ships with, read-only.
 *
 * The real installation keeps them in a managed plugin directory next to its own
 * session data — eleven of them on this host (docx, pdf, pptx, xlsx, frontend-design,
 * schedule, ...). They are NOT in our writable store, so before this the Skills page
 * said "Add your first skill" on a machine that had eleven, and the user's request
 * "do not take away my plugins" was failing outright.
 *
 * We read them where they already are: copying them into our store would duplicate
 * half a megabyte per skill and would go stale on the next app update. Nothing here
 * writes to that directory.
 *
 * Discovery is deliberately shallow and defensive: any missing/unreadable path just
 * contributes nothing, so a machine without the app behaves exactly as before.
 */
function bundledSkillRoots() {
  const roots = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return roots;
  const plugins = path.join(home, 'AppData', 'Local', 'Claude-3p',
    'local-agent-mode-sessions', 'skills-plugin');
  let accounts;
  try {
    accounts = fs.readdirSync(plugins, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const account of accounts) {
    if (!account.isDirectory()) continue;
    const accountDir = path.join(plugins, account.name);
    let versions;
    try {
      versions = fs.readdirSync(accountDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const skills = path.join(accountDir, version.name, 'skills');
      if (fs.existsSync(skills)) roots.push(skills);
    }
  }
  return roots;
}

/** The directory of one bundled skill, or null when it is not installed. */
function bundledSkillDir(id) {
  for (const root of bundledSkillRoots()) {
    const candidate = path.join(root, id);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* not in this runtime */ }
  }
  return null;
}

/** One bundled skill record, or null when that directory has no SKILL.md. */
function readBundledSkill(dir, id) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text) || {};
  const displayName = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : id;
  let updatedAt;
  try { updatedAt = fs.statSync(path.join(dir, 'SKILL.md')).mtime.toISOString(); } catch { /* none */ }
  return {
    skillId: id,
    name: displayName,
    description: typeof fm.description === 'string' ? fm.description : '',
    // Bundled skills are on unless the user turned this one off; the switch state still
    // lives in our index so a toggle survives a restart.
    bundled: true,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * One skill record in the shape the page renders.
 *
 * @param {string} dataDir
 * @param {string} id directory name
 * @param {{skills?: object}} index
 */
function readSkill(dataDir, id, index = readIndex(dataDir)) {
  const dir = path.join(skillsRoot(dataDir), id);
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    text = '';
  }
  const fm = parseFrontmatter(text) || {};
  const meta = (index.skills && index.skills[id]) || {};
  let updatedAt = typeof meta.updatedAt === 'string' ? meta.updatedAt : undefined;
  if (!updatedAt) {
    try { updatedAt = fs.statSync(path.join(dir, 'SKILL.md')).mtime.toISOString(); } catch { /* no file */ }
  }
  const displayName = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : id;
  return {
    skillId: id,
    name: displayName,
    // The record contract requires a string, not undefined: the page renders it as-is
    // in the row subtitle.
    description: typeof fm.description === 'string' ? fm.description : '',
    enabled: meta.enabled !== false,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * Every skill in the store, sorted by name.
 *
 * @param {string} dataDir
 * @returns {Array<object>}
 */
function listSkills(dataDir) {
  const index = readIndex(dataDir);
  const own = skillDirs(dataDir).map((id) => readSkill(dataDir, id, index));
  const seen = new Set(own.map((skill) => skill.skillId));
  const bundled = [];
  for (const root of bundledSkillRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      // A skill the user created with the same id wins: their copy is the one they edit.
      if (seen.has(entry.name)) continue;
      const record = readBundledSkill(path.join(root, entry.name), entry.name);
      if (!record) continue;
      seen.add(entry.name);
      const meta = (index.skills && index.skills[entry.name]) || {};
      bundled.push({ ...record, enabled: meta.enabled !== false });
    }
  }
  return own.concat(bundled).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * The files of one skill, relative to its directory, SKILL.md first.
 *
 * The consumer is
 *   queryFn: async () => ({ files: await bridge.getLocalSkillFiles(id) })
 * so the answer is an array of { path, content }.
 *
 * @param {string} dataDir
 * @param {string} id
 * @returns {Array<{path: string, content: string}>}
 */
function readSkillFiles(dataDir, id) {
  // A skill may live in our store or ship with the installed app. Prefer our copy (that is
  // the one the user may have edited), then fall back to the bundled one.
  const own = path.join(skillsRoot(dataDir), id);
  const root = fs.existsSync(own) ? own : bundledSkillDir(id);
  if (!root) return [];
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        // The editor only renders text; oversize or binary files are skipped rather
        // than shipped to the renderer as mojibake.
        const stat = fs.statSync(full);
        if (stat.size > MAX_PER_FILE_BYTES) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('\u0000')) continue;
        out.push({ path: rel, content });
      } catch { /* unreadable file: skip it, do not fail the whole list */ }
    }
  };
  walk(root, '');
  out.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
  return out;
}

/** Refusal shape the page turns into a toast. */
const refuse = (error, isUserFacingError = false) => ({ ok: false, error, ...(isUserFacingError ? { isUserFacingError: true } : {}) });

/**
 * Create or replace a skill.
 *
 * @param {string} dataDir
 * @param {{name: string, description?: string, skillMd: string, overwrite?: boolean, replaces?: string}} input
 * @returns {{ok: true, skillId: string}|{ok: false, error: string, isUserFacingError?: boolean}}
 */
function saveSkill(dataDir, input) {
  const { name, skillMd } = input || {};
  const problem = nameProblem(name);
  if (problem) return refuse(problem, true);
  if (typeof skillMd !== 'string' || !skillMd.trim()) return refuse('A skill needs instructions.', true);
  if (Buffer.byteLength(skillMd, 'utf8') > MAX_SKILL_MD_BYTES) return refuse('That SKILL.md is too large.', true);

  const root = skillsRoot(dataDir);
  const index = readIndex(dataDir);
  const target = skillIdOf(input.replaces || name);
  const exists = fs.existsSync(path.join(root, target, 'SKILL.md'));
  const replacing = typeof input.replaces === 'string' && input.replaces
    && skillIdOf(input.replaces) !== skillIdOf(name);

  // Replacing an existing skill is allowed only when the caller said so. The page
  // renames through this path too (saveLocalSkill with `replaces`), which is why the
  // target may differ from the requested name.
  if (exists && !input.overwrite && !replacing && skillIdOf(name) === target) {
    return refuse('already_exists');
  }

  const dir = path.join(root, target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf8');

  index.skills[target] = {
    enabled: (index.skills[target] && index.skills[target].enabled) !== false,
    updatedAt: new Date().toISOString(),
  };
  writeIndex(dataDir, index);
  return { ok: true, skillId: target };
}

/**
 * Rename a skill directory and keep its files.
 *
 * @param {string} dataDir
 * @param {string} from current skill id
 * @param {string} to requested new name
 */
function renameSkill(dataDir, from, to) {
  const problem = nameProblem(to);
  if (problem) return refuse(problem, true);
  const root = skillsRoot(dataDir);
  const source = skillIdOf(from);
  const target = skillIdOf(to);
  if (!fs.existsSync(path.join(root, source))) return refuse('No such skill.', true);
  if (source === target) return { ok: true, skillId: target };
  if (fs.existsSync(path.join(root, target))) return refuse('already_exists');

  fs.renameSync(path.join(root, source), path.join(root, target));

  // The SKILL.md front matter carries the display name too; leaving it stale would make
  // the row show the old name after a successful rename.
  const file = path.join(root, target, 'SKILL.md');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const next = text.replace(/^(\s*name\s*:\s*).*$/m, `$1${target}`);
    if (next !== text) fs.writeFileSync(file, next, 'utf8');
  } catch { /* the directory rename is the part that must succeed */ }

  const index = readIndex(dataDir);
  const prior = index.skills[source] || {};
  delete index.skills[source];
  index.skills[target] = {
    enabled: prior.enabled !== false,
    updatedAt: new Date().toISOString(),
  };
  writeIndex(dataDir, index);
  return { ok: true, skillId: target };
}

/**
 * Turn a skill on or off. Disabled skills stay on disk (that is what the toggle means)
 * and simply report `enabled:false` to the page.
 */
function setSkillEnabled(dataDir, id, enabled) {
  const target = skillIdOf(id);
  if (!fs.existsSync(path.join(skillsRoot(dataDir), target))) return refuse('No such skill.', true);
  const index = readIndex(dataDir);
  const prior = index.skills[target] || {};
  index.skills[target] = {
    ...prior,
    enabled: Boolean(enabled),
    updatedAt: typeof prior.updatedAt === 'string' ? prior.updatedAt : new Date().toISOString(),
  };
  writeIndex(dataDir, index);
  return { ok: true, skillId: target };
}

/** Remove a skill and every file it ships. */
function deleteSkill(dataDir, id) {
  const target = skillIdOf(id);
  const dir = path.join(skillsRoot(dataDir), target);
  if (!fs.existsSync(dir)) return refuse('No such skill.', true);
  fs.rmSync(dir, { recursive: true, force: true });
  const index = readIndex(dataDir);
  delete index.skills[target];
  writeIndex(dataDir, index);
  return { ok: true };
}

/** Where a skill lives, for "Reveal in file manager". */
const skillDir = (dataDir, id) => path.join(skillsRoot(dataDir), skillIdOf(id));

module.exports = {
  DEVICE_NAMES,
  INDEX_FILE,
  MAX_NAME,
  MAX_SKILL_MD_BYTES,
  RESERVED,
  deleteSkill,
  indexFile,
  listSkills,
  bundledSkillDir,
  nameProblem,
  parseFrontmatter,
  readSkillFiles,
  refuse,
  renameSkill,
  saveSkill,
  setSkillEnabled,
  skillDir,
  skillIdOf,
  skillsRoot,
};