// Customize > Skills: the store behind the page.
//
// Before this round every skill method on LocalAgentModeSessions was unhandled and fell
// through to the generic fallback, which answered [] for the list and null for every
// mutation. The page therefore had a complete UI (Add skill, Upload, Create, toggle,
// rename, delete) over nothing at all.
//
// Measured live on the replica, before the fix:
//   listLocalSkills()                     -> []
//   saveLocalSkill('demo2', ..., skillMd) -> null
//   getLocalSkillFiles('demo2')           -> []
//   page, with a real .claude/skills/demo-skill/SKILL.md on disk:
//     "Add your first skills" still rendered, demo-skill nowhere in the DOM
//
// After the fix the same calls answer real data. The tests below pin the contract the
// page reads (verified against the shipped bundle's own validators, index.chunk-lzaSYO3Q):
//   list  : array of {skillId,name,description,enabled} -- all strings + boolean
//   files : array of {path, content}
//   save  : {ok, skillId} | {ok:false, error, isUserFacingError?}; "already_exists" is
//           its own branch in the UI, so it must be that exact string
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const skills = require('../desktop/local-skills.cjs');
const zipRead = require('../desktop/zip-read.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

const MD = (name, description = 'A skill', body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fx-skills-'));
}

// The store now also lists the skills the installed app ships with, read from the user's
// profile. These tests are about OUR store, so point the profile at an empty directory:
// otherwise the suite passes or fails depending on what the host machine has installed.
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-emptyhome-'));
const savedProfile = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = EMPTY_HOME;
process.env.HOME = EMPTY_HOME;
process.on('exit', () => {
  if (savedProfile.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile.USERPROFILE;
  if (savedProfile.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedProfile.HOME;
});

/** A bridge over a throwaway data directory, exactly as main.cjs wires it. */
function makeBridge() {
  const dataDir = tmpDir();
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', dataDir, kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  // ipcMain.handle wraps every answer in a promise, so the test must await too.
  const call = async (method, ...args) => {
    const channel = [...handlers.keys()].find((c) => c.endsWith(`_$_LocalAgentModeSessions_$_${method}`));
    if (!channel) throw new Error(`no handler for LocalAgentModeSessions.${method}`);
    return await handlers.get(channel)({}, ...args);
  };
  return { call, dataDir, root: path.join(dataDir, 'skills') };
}

/** Build a Deflate-encoded ZIP with the given files (a real archive, not a stub). */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, deflated]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

// ---- the store itself ------------------------------------------------------

test('the list is derived from disk, so a hand-made skill shows up', () => {
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, 'skills', 'handmade'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'skills', 'handmade', 'SKILL.md'), MD('handmade', 'Made by hand'));

  const list = skills.listSkills(dataDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].skillId, 'handmade');
  assert.equal(list[0].name, 'handmade');
  assert.equal(list[0].description, 'Made by hand');
  assert.equal(list[0].enabled, true);
  // The page renders updatedAt when present; the fixture must have one either way.
  assert.equal(typeof list[0].updatedAt, 'string');
});

test('every record matches the shipped validator: three strings and a boolean', () => {
  const dataDir = tmpDir();
  skills.saveSkill(dataDir, { name: 'alpha', description: 'one', skillMd: MD('alpha', 'one') });
  const [row] = skills.listSkills(dataDir);
  // dCt() in index.chunk-lzaSYO3Q.js
  assert.equal(typeof row.skillId, 'string');
  assert.equal(typeof row.name, 'string');
  assert.equal(typeof row.description, 'string');
  assert.equal(typeof row.enabled, 'boolean');
});

test('a SKILL.md with no front matter still yields a usable row', () => {
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, 'skills', 'bare'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'skills', 'bare', 'SKILL.md'), 'no front matter here');
  const [row] = skills.listSkills(dataDir);
  assert.equal(row.skillId, 'bare');
  assert.equal(row.name, 'bare', 'falls back to the directory name');
  assert.equal(row.description, '', 'description is a string, not undefined');
});

test('saving writes SKILL.md and refuses a duplicate unless told to overwrite', () => {
  const dataDir = tmpDir();
  const first = skills.saveSkill(dataDir, { name: 'dup', description: 'x', skillMd: MD('dup') });
  assert.deepEqual(first, { ok: true, skillId: 'dup' });
  assert.match(fs.readFileSync(path.join(dataDir, 'skills', 'dup', 'SKILL.md'), 'utf8'), /name: dup/);

  const again = skills.saveSkill(dataDir, { name: 'dup', description: 'x', skillMd: MD('dup') });
  assert.equal(again.ok, false);
  // The UI switches on this exact string to show "already exists".
  assert.equal(again.error, 'already_exists');

  const over = skills.saveSkill(dataDir, { name: 'dup', description: 'y', skillMd: MD('dup', 'Changed'), overwrite: true });
  assert.equal(over.ok, true);
  assert.match(fs.readFileSync(path.join(dataDir, 'skills', 'dup', 'SKILL.md'), 'utf8'), /description: Changed/);
});

test('names that could escape the store are refused', () => {
  const dataDir = tmpDir();
  for (const bad of ['../escape', 'a/b', 'x\\y', '.hidden', '', '   ', 'plugins', 'a..b']) {
    const result = skills.saveSkill(dataDir, { name: bad, description: 'x', skillMd: MD('z') });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  const ok = skills.saveSkill(dataDir, { name: 'Safe-Name_1', description: 'x', skillMd: MD('Safe-Name_1') });
  assert.equal(ok.ok, true);
});

test('Windows device names are refused instead of creating an unusable directory', () => {
  // Measured before this guard: saveSkill('CON') answered {ok:true} and node really did
  // create a directory called CON, which every legacy path API (Explorer, robocopy,
  // most backups) resolves to the console device instead of a folder.
  const dataDir = tmpDir();
  for (const bad of ['CON', 'nul', 'aux', 'com1', 'lpt9', 'CON.txt']) {
    const result = skills.saveSkill(dataDir, { name: bad, description: 'x', skillMd: MD('z') });
    assert.equal(result.ok, false, `${bad} must be refused`);
    assert.match(result.error, /reserved device name/i);
  }
  assert.deepEqual(skills.listSkills(dataDir), [], 'nothing was created on disk');
});

test('rename moves the files and updates the front matter name', () => {
  const dataDir = tmpDir();
  skills.saveSkill(dataDir, { name: 'old', description: 'd', skillMd: MD('old') });
  fs.writeFileSync(path.join(dataDir, 'skills', 'old', 'notes.txt'), 'kept');

  const result = skills.renameSkill(dataDir, 'old', 'new');
  assert.deepEqual(result, { ok: true, skillId: 'new' });
  assert.equal(fs.existsSync(path.join(dataDir, 'skills', 'old')), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'skills', 'new', 'notes.txt'), 'utf8'), 'kept');
  assert.match(fs.readFileSync(path.join(dataDir, 'skills', 'new', 'SKILL.md'), 'utf8'), /name: new/);
  assert.equal(skills.listSkills(dataDir)[0].name, 'new');
});

test('rename refuses an existing name and an unknown skill', () => {
  const dataDir = tmpDir();
  skills.saveSkill(dataDir, { name: 'a', description: 'x', skillMd: MD('a') });
  skills.saveSkill(dataDir, { name: 'b', description: 'x', skillMd: MD('b') });
  assert.equal(skills.renameSkill(dataDir, 'a', 'b').error, 'already_exists');
  assert.equal(skills.renameSkill(dataDir, 'missing', 'c').ok, false);
});

test('the enable toggle persists and survives a re-read', () => {
  const dataDir = tmpDir();
  skills.saveSkill(dataDir, { name: 't', description: 'x', skillMd: MD('t') });
  assert.equal(skills.setSkillEnabled(dataDir, 't', false).ok, true);
  assert.equal(skills.listSkills(dataDir)[0].enabled, false);
  // A fresh read proves it was written, not just held in memory.
  const index = JSON.parse(fs.readFileSync(skills.indexFile(dataDir), 'utf8'));
  assert.equal(index.skills.t.enabled, false);
  skills.setSkillEnabled(dataDir, 't', true);
  assert.equal(skills.listSkills(dataDir)[0].enabled, true);
});

test('delete removes the directory and the index entry', () => {
  const dataDir = tmpDir();
  skills.saveSkill(dataDir, { name: 'gone', description: 'x', skillMd: MD('gone') });
  assert.deepEqual(skills.deleteSkill(dataDir, 'gone'), { ok: true });
  assert.equal(fs.existsSync(path.join(dataDir, 'skills', 'gone')), false);
  assert.deepEqual(skills.listSkills(dataDir), []);
  assert.equal(skills.deleteSkill(dataDir, 'gone').ok, false);
});

test('file listing puts SKILL.md first and keeps the tree relative', () => {
  const dataDir = tmpDir();
  skills.saveSkill(dataDir, { name: 'tree', description: 'x', skillMd: MD('tree') });
  fs.mkdirSync(path.join(dataDir, 'skills', 'tree', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'skills', 'tree', 'scripts', 'run.sh'), 'echo hi');
  fs.writeFileSync(path.join(dataDir, 'skills', 'tree', 'a.txt'), 'a');

  const files = skills.readSkillFiles(dataDir, 'tree');
  assert.deepEqual(files.map((f) => f.path), ['SKILL.md', 'a.txt', 'scripts/run.sh']);
  assert.equal(files[0].content, MD('tree'));
});

// ---- the bridge handlers ---------------------------------------------------

test('the bridge answers the nine skill methods with real data', async () => {
  const bridge = makeBridge();
  assert.deepEqual(await bridge.call('listLocalSkills'), []);

  const saved = await bridge.call('saveLocalSkill', 'live', 'From the bridge', MD('live', 'From the bridge'), false, undefined);
  assert.deepEqual(saved, { ok: true, skillId: 'live' });

  const list = await bridge.call('listLocalSkills');
  assert.equal(list.length, 1);
  assert.equal(list[0].skillId, 'live');
  assert.equal(list[0].description, 'From the bridge');

  const files = await bridge.call('getLocalSkillFiles', 'live');
  assert.deepEqual(files.map((f) => f.path), ['SKILL.md']);

  assert.equal((await bridge.call('setLocalSkillEnabled', 'live', false)).ok, true);
  assert.equal((await bridge.call('listLocalSkills'))[0].enabled, false);

  assert.deepEqual(await bridge.call('renameLocalSkill', 'live', 'renamed'), { ok: true, skillId: 'renamed' });
  assert.equal((await bridge.call('listLocalSkills'))[0].skillId, 'renamed');

  assert.deepEqual(await bridge.call('deleteLocalSkill', 'renamed'), { ok: true });
  assert.deepEqual(await bridge.call('listLocalSkills'), []);
});

test('the handlers write under the data directory the app is configured with', async () => {
  const bridge = makeBridge();
  await bridge.call('saveLocalSkill', 'where', 'd', MD('where'), false, undefined);
  assert.equal(fs.existsSync(path.join(bridge.root, 'where', 'SKILL.md')), true);
});

test('syncSkills answers ok and a missing skill is refused, not silently accepted', async () => {
  const bridge = makeBridge();
  assert.deepEqual(await bridge.call('syncSkills'), { ok: true });
  const missing = await bridge.call('renameLocalSkill', 'nope', 'still-nope');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No such skill/);
  // A missing skill has no files; an empty array is the honest answer, not null.
  assert.deepEqual(await bridge.call('getLocalSkillFiles', 'nope'), []);
});

// ---- archive upload --------------------------------------------------------

test('saveLocalSkillArchive unpacks the manifest and the files beside it', async () => {
  const bridge = makeBridge();
  const archive = makeZip({
    'bundle/SKILL.md': MD('bundled', 'From a zip'),
    'bundle/scripts/go.sh': 'echo go',
  });

  const result = await bridge.call('saveLocalSkillArchive', {
    name: 'bundled',
    description: 'From a zip',
    skillMd: MD('bundled', 'From a zip'),
    base64Content: archive.toString('base64'),
    overwrite: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.skillId, 'bundled');
  assert.equal(fs.readFileSync(path.join(bridge.root, 'bundled', 'scripts', 'go.sh'), 'utf8'), 'echo go');
  assert.match(fs.readFileSync(path.join(bridge.root, 'bundled', 'SKILL.md'), 'utf8'), /From a zip/);
});

test('an archive without SKILL.md is refused with a readable reason', async () => {
  const result = await makeBridge().call('saveLocalSkillArchive', {
    name: 'nope',
    description: '',
    skillMd: '',
    base64Content: makeZip({ 'readme.txt': 'nothing here' }).toString('base64'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no SKILL\.md/i);
  assert.equal(result.isUserFacingError, true);
});

test('zip entry names cannot escape the skill directory', () => {
  assert.equal(zipRead.safeEntryPath('../evil.txt'), null);
  assert.equal(zipRead.safeEntryPath('/abs/evil.txt'), 'abs/evil.txt');
  assert.equal(zipRead.safeEntryPath('ok/nested/file.txt'), 'ok/nested/file.txt');
  const { entries } = zipRead.readZip(makeZip({ '../evil.txt': 'x', 'SKILL.md': MD('z') }));
  assert.equal(entries.some((e) => e.name === '../evil.txt'), true, 'the reader still returns it');
  assert.equal(zipRead.safeEntryPath('../evil.txt'), null, 'but the writer refuses it');
});

test('the front-matter reader handles CRLF, quotes and an absent block', () => {
  assert.deepEqual(skills.parseFrontmatter('---\r\nname: "q"\r\ndescription: \'single\'\r\n---\r\nbody'), {
    name: 'q',
    description: 'single',
  });
  assert.equal(skills.parseFrontmatter('no front matter'), null);
});