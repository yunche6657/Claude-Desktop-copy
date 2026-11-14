// A restart must preserve sessions, transcripts and their renderable shape.
//
// Persistence claims were previously checked in-process: flush(), then read the file
// back. A real restart also loads the store into a NEW kernel, which is where a
// malformed record would actually surface. So these tests create a second kernel over
// the same store file and verify what it can read.
//
// Verified live too (tools/probes/restart-persistence.mjs): after killing and relaunching
// the app, the session, its title, its 2-entry transcript and the rendered conversation
// all survived, with no crash and no "couldn't be found".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

const okAgent = () => ({
  model: 's',
  tools: [],
  async run() { return { text: 'ok', stopReason: 'end_turn' }; },
});

/** A kernel over a chosen store file, so a second one can reopen the same data. */
function kernelAt(storePath) {
  return createSessionKernel({ emit: () => {}, createAgent: okAgent, storePath });
}

test('a session survives being reloaded by a fresh kernel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = kernelAt(storePath);
  const s = first.start({ cwd: 'C:\\w' });
  first.update(s.sessionId, { title: 'survivor', permissionMode: 'auto', fastMode: true });
  first.flush();

  const second = kernelAt(storePath);
  const rec = second.getSession(s.sessionId);
  assert.ok(rec, 'the session must still exist');
  assert.equal(rec.title, 'survivor');
  assert.equal(rec.permissionMode, 'auto');
  assert.equal(rec.fastMode, true);
  assert.equal(rec.isRunning, false, 'a reloaded session must not look busy');
});

test('a transcript survives and keeps the fields the renderer reads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = kernelAt(storePath);
  const s = first.start({ cwd: 'C:\\w' });
  first.sendMessage(s.sessionId, 'remember RESTART-TOKEN');
  // Let the turn settle so the transcript is written.
  await new Promise((r) => setTimeout(r, 150));
  first.flush();

  const second = kernelAt(storePath);
  const entries = second.getTranscript(s.sessionId);
  assert.ok(entries.length >= 2, 'user + assistant at minimum');

  for (const e of entries) {
    assert.equal(typeof e.type, 'string');
    assert.ok(e.message && typeof e.message === 'object');
    const content = e.message.content;
    assert.ok(typeof content === 'string' || Array.isArray(content),
      'content must stay renderable after a reload');
  }

  // Assert on the USER row, not on the whole blob: a blob search stays green when the text
  // lands in the wrong row (an assistant echo, for example), which is a different defect.
  const userRow = entries.find((e) => e.type === 'user');
  assert.ok(userRow, 'the reloaded transcript has no user row');
  assert.ok(JSON.stringify(userRow.message.content).includes('RESTART-TOKEN'),
    'the user text did not survive in the user row');
  assert.ok(entries.some((e) => e.type === 'assistant'),
    'the reply must survive too');
});

test('an archived session stays archived across a reload', async () => {
  // Otherwise archived sessions silently reappear in the active list.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = kernelAt(storePath);
  const a = first.start({ cwd: 'C:\\w' });
  const b = first.start({ cwd: 'C:\\w' });
  first.update(a.sessionId, { isArchived: true });
  first.flush();

  const second = kernelAt(storePath);
  assert.equal(second.getSession(a.sessionId).isArchived, true);
  assert.equal(second.getSession(b.sessionId).isArchived, false);
});

test('a deleted session does not come back after a reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = kernelAt(storePath);
  const s = first.start({ cwd: 'C:\\w' });
  first.remove(s.sessionId);
  first.flush();

  const second = kernelAt(storePath);
  assert.equal(second.getSession(s.sessionId), null);
});

test('a killed turn does not leave the reloaded session stuck busy', async () => {
  // Round 21: isRunning stuck true made the session unusable forever. A reload must not
  // resurrect that flag.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = kernelAt(storePath);
  first.flush();

  const second = kernelAt(storePath);
  const s = second.start({ cwd: 'C:\\w' });
  second.update(s.sessionId, { isRunning: true });
  second.flush();

  const third = kernelAt(storePath);
  const rec = third.getSession(s.sessionId);
  // Whatever was persisted, a freshly loaded kernel must not treat it as mid-turn: it
  // has no controller for it, and refusing new messages would deadlock the session.
  assert.equal(rec.isRunning, false, 'a reload must clear a stale isRunning');
});

test('repeated flush cycles do not corrupt the store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const kernel = kernelAt(storePath);
  const s = kernel.start({ cwd: 'C:\\w' });
  for (let i = 0; i < 5; i += 1) {
    kernel.update(s.sessionId, { title: `title-${i}` });
    kernel.flush();
  }

  const reloaded = kernelAt(storePath);
  assert.equal(reloaded.getSession(s.sessionId).title, 'title-4');
  // The file must still be valid JSON with both sections.
  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.ok(Array.isArray(raw.sessions));
  assert.equal(typeof raw.transcripts, 'object');
});

// ---------------------------------------------------------------------------
// Archiving through the REAL bridge handlers, across a reload.
//
// The test above sets `isArchived` via update(), which is one path. The UI archives
// through LocalSessions.archive / unarchive, which reach the kernel via applyPatch. Those
// are what a restart actually has to preserve.
//
// Verified against a live process restart too: after Stop-Process and relaunch the
// session still reported isArchived:true, appeared in loadArchivedSessions, stayed out of
// the active list, and its title was absent from the sidebar text.

/** A bridge over the given store, so archive() goes through the shipped handler. */
function bridgeAt(storePath) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = kernelAt(storePath);
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { kernel, call };
}

test('archive() through the bridge survives a reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = bridgeAt(storePath);
  const keep = first.kernel.start({ cwd: 'C:\\w', title: 'stays-active' });
  const gone = first.kernel.start({ cwd: 'C:\\w', title: 'gets-archived' });
  const res = await first.call('LocalSessions', 'archive', gone.sessionId);
  assert.equal(res.ok, true);
  first.kernel.flush();

  const second = bridgeAt(storePath);
  assert.equal(second.kernel.getSession(gone.sessionId).isArchived, true, 'archived flag must persist');
  assert.equal(second.kernel.getSession(keep.sessionId).isArchived, false, 'others stay active');
  // The title must survive too: an archived session with no title is unidentifiable.
  assert.equal(second.kernel.getSession(gone.sessionId).title, 'gets-archived');
});

test('unarchive() through the bridge survives a reload', async () => {
  // Restoring must persist as firmly as archiving, otherwise a restored session
  // reappears in the archive list after every restart.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = bridgeAt(storePath);
  const s = first.kernel.start({ cwd: 'C:\\w', title: 'restored' });
  await first.call('LocalSessions', 'archive', s.sessionId);
  const back = await first.call('LocalSessions', 'unarchive', s.sessionId);
  assert.equal(back.ok, true);
  first.kernel.flush();

  const second = bridgeAt(storePath);
  assert.equal(second.kernel.getSession(s.sessionId).isArchived, false);
});

test('a reloaded archived session is excluded from an active-list filter', async () => {
  // This mirrors what the sidebar does: filter the session list by isArchived. A wrong
  // flag after reload puts an archived session back in recents — visible on screen, while
  // every bridge answer would still look correct.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = bridgeAt(storePath);
  const live = first.kernel.start({ cwd: 'C:\\w' });
  const archived = first.kernel.start({ cwd: 'C:\\w' });
  await first.call('LocalSessions', 'archive', archived.sessionId);
  first.kernel.flush();

  const second = bridgeAt(storePath);
  const all = second.kernel.getAll();
  const active = all.filter((s) => !s.isArchived).map((s) => s.sessionId);
  const archivedIds = all.filter((s) => s.isArchived).map((s) => s.sessionId);

  assert.ok(active.includes(live.sessionId));
  assert.equal(active.includes(archived.sessionId), false, 'archived must not appear active');
  assert.deepEqual(archivedIds, [archived.sessionId]);
});

test('archiving is idempotent across a reload', async () => {
  // Archiving twice must not corrupt the flag, and a reload in between must not either.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = bridgeAt(storePath);
  const s = first.kernel.start({ cwd: 'C:\\w' });
  await first.call('LocalSessions', 'archive', s.sessionId);
  first.kernel.flush();

  const second = bridgeAt(storePath);
  await second.call('LocalSessions', 'archive', s.sessionId);
  assert.equal(second.kernel.getSession(s.sessionId).isArchived, true);
  second.kernel.flush();

  const third = bridgeAt(storePath);
  assert.equal(third.kernel.getSession(s.sessionId).isArchived, true);
});
