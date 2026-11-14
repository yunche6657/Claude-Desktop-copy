// Bundled skills must not be taken away.
//
// The installed app ships eleven skills (docx, pdf, pptx, xlsx, frontend-design,
// schedule, setup-claude, setup-cowork, consolidate-memory, explain-usage,
// pdf-reading) in a managed plugin directory next to its own session data. They are
// NOT in the writable store the Skills page used to read, so the page rendered
// "Add your first skill" on a machine that had eleven, and asking one of them to
// do something had nothing to resolve.
//
// These tests run against a fake installation so they do not depend on this host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { listSkills } = require(path.join(ROOT, 'desktop', 'local-skills.cjs'));

/** Build a throwaway HOME with one managed runtime that ships skills. */
function fakeHome(skills) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-home-'));
  const dir = path.join(home, 'AppData', 'Local', 'Claude-3p',
    'local-agent-mode-sessions', 'skills-plugin');
  const runtime = path.join(dir, '00000000-0000-4000-8000-000000000001', 'runtime-1', 'skills');
  for (const [name, body] of Object.entries(skills)) {
    fs.mkdirSync(path.join(runtime, name), { recursive: true });
    fs.writeFileSync(path.join(runtime, name, 'SKILL.md'), body, 'utf8');
  }
  return { home, runtime };
}

function withHome(home, fn) {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try { return fn(); } finally {
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
  }
}

const skillMd = (name, description) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;

test('bundled skills are listed, not reported as none', () => {
  const { home } = fakeHome({
    docx: skillMd('docx', 'Word documents.'),
    pdf: skillMd('pdf', 'PDF files.'),
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-'));
  const skills = withHome(home, () => listSkills(dataDir));
  assert.equal(skills.length, 2, 'both bundled skills must be listed');
  assert.deepEqual(skills.map((s) => s.name).sort(), ['docx', 'pdf']);
  assert.equal(skills[0].enabled, true, 'bundled skills start enabled');
  assert.equal(skills[0].bundled, true, 'they are marked as bundled');
  assert.equal(skills[0].description.length > 0, true, 'the description comes from SKILL.md');
});

test('a user skill with the same id wins over the bundled copy', () => {
  const { home } = fakeHome({ docx: skillMd('docx', 'Bundled copy.') });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-'));
  const mine = path.join(dataDir, 'skills', 'docx');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), skillMd('docx', 'My edited copy.'), 'utf8');
  const skills = withHome(home, () => listSkills(dataDir));
  assert.equal(skills.length, 1, 'one row, not two');
  assert.equal(skills[0].description, 'My edited copy.', 'the user copy is the one shown');
  assert.equal(skills[0].bundled, undefined, 'it is not flagged as bundled');
});

test('a missing installation still answers an empty array', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-nohome-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-'));
  const skills = withHome(home, () => listSkills(dataDir));
  assert.deepEqual(skills, [], 'no directory contributes nothing');
});

test('a directory without SKILL.md is skipped, not a broken row', () => {
  const { home, runtime } = fakeHome({ docx: skillMd('docx', 'Word documents.') });
  fs.mkdirSync(path.join(runtime, 'not-a-skill'), { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-'));
  const skills = withHome(home, () => listSkills(dataDir));
  assert.equal(skills.length, 1);
  assert.equal(skills[0].skillId, 'docx');
});

test('disabling a bundled skill is remembered without touching the app files', () => {
  const { home, runtime } = fakeHome({ schedule: skillMd('schedule', 'Scheduled tasks.') });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-'));
  fs.mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'skills', '_skills.json'),
    JSON.stringify({ skills: { schedule: { enabled: false } } }), 'utf8');
  const before = fs.statSync(path.join(runtime, 'schedule', 'SKILL.md')).mtimeMs;
  const skills = withHome(home, () => listSkills(dataDir));
  assert.equal(skills[0].enabled, false, 'the switch state comes from our index');
  assert.equal(fs.statSync(path.join(runtime, 'schedule', 'SKILL.md')).mtimeMs, before,
    'reading must not write into the installed app');
});
