// The persisted store must satisfy the invariants the code relies on.
//
// Rounds 24-25 found classes of defect that no error message ever reported, because
// the store and the validators disagreed silently:
//
//   - 27 records held permissionMode "auto", absent from permissions.VALID_MODES
//   - conversation_preferences was an object where a string was required (round 15)
//   - listCliSessions answered an object where an array was required (round 13)
//
// These tests pin the invariants so a future writer cannot reintroduce them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { VALID_MODES, decide, ACTIONS } = require('../desktop/permissions.cjs');

/** A kernel writing to a throwaway store, so the real one is untouched. */
function makeKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-audit-'));
  const storePath = path.join(dir, 'kernel-sessions.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  return { kernel, storePath, dir };
}

test('a fresh record satisfies every field invariant', async () => {
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  assert.ok(VALID_MODES.has(s.permissionMode), `permissionMode ${s.permissionMode} must be valid`);
  assert.equal(typeof s.model, 'string');
  assert.ok(s.model.length > 0);
  assert.equal(typeof s.isRunning, 'boolean');
  assert.equal(typeof s.isArchived, 'boolean');
  assert.equal(typeof s.isStarred, 'boolean');
  assert.equal(typeof s.fastMode, 'boolean');
  assert.ok(Array.isArray(s.pendingToolPermissions));
  assert.ok(Array.isArray(s.enabledMcpTools));
  assert.ok(Array.isArray(s.mountedProjects));
  assert.ok(Array.isArray(s.userSelectedFolders));
  // Epoch milliseconds, not ISO strings — the UI does arithmetic on these.
  assert.ok(s.createdAt > 1e12 && s.createdAt < 1e13);
  assert.ok(s.lastActivityAt > 1e12 && s.lastActivityAt < 1e13);
});

test('every mode the UI can send is storable and valid', async () => {
  // The round-25 defect: "auto" was offered by the UI but absent from the validator.
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });
  for (const mode of ['ask', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'default']) {
    const updated = kernel.update(s.sessionId, { permissionMode: mode });
    assert.equal(updated.permissionMode, mode);
    assert.ok(VALID_MODES.has(updated.permissionMode));
  }
});

test('a stored permissionMode always has a defined policy', async () => {
  // Anything storable must be decidable, or the tool gate reads undefined.prompt.
  for (const mode of VALID_MODES) {
    for (const action of Object.values(ACTIONS)) {
      const policy = decide(mode, action);
      assert.ok(policy && typeof policy.prompt === 'boolean', `${mode}/${action}`);
    }
  }
});

test('transcript entries carry what the renderer reads', async () => {
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.sendMessage(s.sessionId, 'hello');
  await new Promise((r) => setTimeout(r, 120));

  const entries = kernel.getTranscript(s.sessionId);
  assert.ok(Array.isArray(entries));
  for (const e of entries) {
    assert.equal(typeof e.type, 'string', 'the renderer switches on type');
    assert.ok(e.message && typeof e.message === 'object', 'content lives under message');
    const content = e.message.content;
    assert.ok(content !== undefined && content !== null, 'content must not be null');
    assert.ok(typeof content === 'string' || Array.isArray(content),
      `content must be string|array, got ${typeof content}`);
    if (Array.isArray(content)) {
      for (const block of content) {
        assert.equal(typeof block.type, 'string', 'each block needs a type');
      }
    }
    if (e.uuid !== undefined) assert.equal(typeof e.uuid, 'string');
    if (e.parentUuid != null) assert.equal(typeof e.parentUuid, 'string');
  }
});

test('the store round-trips through JSON without changing shape', async () => {
  // A field that does not survive the write is invisible after a restart.
  const { kernel, storePath } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.update(s.sessionId, { permissionMode: 'auto', fastMode: true, model: 'claude-opus-5-5' });
  kernel.flush();

  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const record = (saved.sessions || []).find((x) => x.sessionId === s.sessionId);
  assert.ok(record, 'the session must be in the store');
  assert.equal(record.permissionMode, 'auto');
  assert.equal(record.fastMode, true);
  assert.equal(record.model, 'claude-opus-5-5');
});

test('archiving moves a session out of the active list and back', async () => {
  // The loop the archived view depends on.
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  kernel.update(s.sessionId, { isArchived: true });
  const archived = kernel.getAll().find((x) => x.sessionId === s.sessionId);
  assert.equal(archived.isArchived, true);

  kernel.update(s.sessionId, { isArchived: false });
  const restored = kernel.getAll().find((x) => x.sessionId === s.sessionId);
  assert.equal(restored.isArchived, false);
});

/** The bridge, so channel-level behaviour (search, archive) is exercised too. */
function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-'));
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath: path.join(dir, 'kernel-sessions.json'),
  });
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

test('search answers an array of {sessionId, snippet}', async () => {
  // searchSessions is implemented in the bridge, not the kernel.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  kernel.sendMessage(s.sessionId, 'the token ZQSEARCHTOKEN lives here');
  await new Promise((r) => setTimeout(r, 200));

  for (const service of ['LocalSessions', 'LocalAgentModeSessions']) {
    const hits = await call(service, 'searchSessions', 'ZQSEARCHTOKEN');
    assert.ok(Array.isArray(hits), `${service}: an object here crashes the palette`);
    for (const hit of hits) {
      assert.equal(typeof hit.sessionId, 'string', service);
      assert.equal(typeof hit.snippet, 'string', service);
    }
  }
});

test('a search with no match answers an empty array, not null', async () => {
  const { kernel, call } = makeBridge();
  kernel.start({ cwd: 'C:\\w' });
  const hits = await call('LocalSessions', 'searchSessions', 'ZZZ_DEFINITELY_ABSENT_ZZZ');
  assert.ok(Array.isArray(hits));
  assert.equal(hits.length, 0);
});
