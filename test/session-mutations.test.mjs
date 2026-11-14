// Tests for the session mutations the sidebar and detail view perform.
//
// Rename, star, archive, unarchive and delete used to have no handler, so the
// bridge answered null: the call resolved, no state changed, and no error was
// reported. The UI re-rendered the unchanged session, which reads as "the action
// was accepted and did nothing". These tests pin the behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function makeBridge({ storePath, createAgent } = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const events = [];
  // Bridge events are pushed to the window's webContents, not into the kernel's
  // emit, so a fake window is what makes them observable here.
  const sent = [];
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => { sent.push({ channel, payload }); },
    },
  };
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: createAgent || (() => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } })),
    // A store path lets a second bridge reopen the same data, which is how the
    // persistence tests simulate a restart without spawning a process.
    ...(storePath ? { storePath } : {}),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => fakeWindow,
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
  return { kernel, call, events, sent };
}

test('updateSession renames a session', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });

  const updated = await call('LocalSessions', 'updateSession', s.sessionId, {
    title: 'a better name',
    titleSource: 'auto',
  });
  assert.equal(updated.title, 'a better name');
  assert.equal(kernel.getSession(s.sessionId).title, 'a better name');
});

test('session bridge reorders and cancels pending duplicate-start messages', async () => {
  let release; const gate=new Promise(resolve=>{release=resolve;}); let runs=0;
  const {kernel,call}=makeBridge({createAgent:()=>({model:'m',tools:[],async run(){if(++runs===1) await gate;return {text:'done',stopReason:'end_turn'};}})});
  const {sessionId}=kernel.start({cwd:'C:\\work'});
  const first=kernel.sendMessage(sessionId,'first');
  const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
  const a=kernel.start({sessionId,message:'queued a',messageUuid:one});
  const cancelled=assert.rejects(a,{name:'QueuedMessageCancelledError'});
  const b=kernel.start({sessionId,message:'queued b',messageUuid:two});
  assert.equal(await call('LocalSessions','reorderQueuedMessage',sessionId,two,one),true);
  assert.equal(await call('LocalSessions','cancelQueuedMessage',sessionId,one),true);
  await cancelled; assert.equal(await call('LocalSessions','cancelQueuedMessage',sessionId,one),false);
  release(); await first; assert.equal((await b).sessionId,sessionId);
  kernel.dispose();
});

test('both session bridges apply color and display selection with native clearing semantics', async () => {
  const { kernel, call } = makeBridge();
  const { sessionId } = kernel.start({ cwd: 'C:\\work' });
  kernel.update(sessionId, { cuAllowedApps: [{ bundleId: 'z' }, { bundleId: 'a' }] });
  let updated = await call('LocalSessions', 'updateSession', sessionId, { color: 'red', cuSelectedDisplayId: 3 });
  assert.equal(updated.color, 'red');
  assert.equal(updated.cuSelectedDisplayId, 3);
  assert.equal(updated.cuDisplayPinnedByModel, false);
  assert.equal(updated.cuDisplayResolvedForApps, 'a,z');
  updated = await call('LocalAgentModeSessions', 'updateSession', sessionId, { color: 'invalid', cuSelectedDisplayId: null });
  assert.equal(updated.color, undefined);
  assert.equal(updated.cuSelectedDisplayId, undefined);
  assert.equal(updated.cuDisplayResolvedForApps, undefined);
});

// ---------------------------------------------------------------------------
// titleSource: the field that decides whether a user's rename survives.
//
// The renderer renames with { title, titleSource: "user" } (c4ae8f050-Bp9wMrEB.js):
//   w(e.id, { title: t, titleSource: "user" })
// and the auto-title path explicitly SKIPS a session whose source is user/tool
// (caec4a2d4-BRHJTwC2.js):
//   n.titleSource === "user" || n.titleSource === "tool" || ... || await _n(e, t, "auto")
//
// So if the bridge drops titleSource, the next auto title overwrites what the user typed —
// the rename appears to work and then quietly changes later.

test('a user rename persists titleSource "user"', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work', title: 'original' });

  await call('LocalSessions', 'updateSession', s.sessionId, {
    title: 'typed by the user',
    titleSource: 'user',
  });

  const rec = kernel.getSession(s.sessionId);
  assert.equal(rec.title, 'typed by the user');
  assert.equal(rec.titleSource, 'user');
  // The guard the renderer applies before letting an auto title replace it.
  const autoTitleWouldSkip = rec.titleSource === 'user' || rec.titleSource === 'tool';
  assert.equal(autoTitleWouldSkip, true, 'an auto title must not overwrite a user rename');
});

test('an auto title is recorded as auto, so it stays replaceable', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });

  await call('LocalSessions', 'updateSession', s.sessionId, {
    title: 'Say exactly: X',
    titleSource: 'auto',
  });

  const rec = kernel.getSession(s.sessionId);
  assert.equal(rec.titleSource, 'auto');
  // The same guard must NOT skip an auto title: a later auto title may refine it.
  assert.equal(rec.titleSource === 'user' || rec.titleSource === 'tool', false);
});

test('the three legal titleSource values are the ones the renderer accepts', async () => {
  // c4ae8f050-Bp9wMrEB.js:
  //   function k(e){ return e === "auto" || e === "user" || e === "tool" ? e : null }
  // Anything else is normalised to null, i.e. treated as "no source".
  const legal = ['auto', 'user', 'tool'];
  for (const source of legal) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\work' });
    await call('LocalSessions', 'updateSession', s.sessionId, { title: `t-${source}`, titleSource: source });
    assert.equal(kernel.getSession(s.sessionId).titleSource, source);
  }
});

test('titleSource is only recorded together with a title', async () => {
  // applyPatch gates it on `'title' in next`: a patch that only carries a source cannot
  // relabel an existing title, which would otherwise let an auto update masquerade as a
  // user rename.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work', title: 'keep me' });

  await call('LocalSessions', 'updateSession', s.sessionId, { titleSource: 'auto' });

  const rec = kernel.getSession(s.sessionId);
  assert.equal(rec.title, 'keep me', 'the title must be untouched');
  assert.notEqual(rec.titleSource, 'auto', 'a source without a title must not be recorded');
});

test('a rename does not disturb the other fields', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  await call('LocalSessions', 'setPermissionMode', s.sessionId, 'plan');
  await call('LocalSessions', 'updateSession', s.sessionId, { title: 'renamed', titleSource: 'user' });

  const rec = kernel.getSession(s.sessionId);
  assert.equal(rec.permissionMode, 'plan');
  assert.equal(rec.titleSource, 'user');
  assert.equal(rec.cwd, 'C:\\work');
});

test('updateSession stars a session', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  const updated = await call('LocalSessions', 'updateSession', s.sessionId, { isStarred: true });
  assert.equal(updated.isStarred, true);
  assert.equal(kernel.getSession(s.sessionId).isStarred, true);
});

test('a star survives a restart through the store', async () => {
  // Verified against a live relaunch too: after Stop-Process the session still reported
  // isStarred:true, and the row carried a star mark in the sidebar.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'star-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = makeBridge({ storePath });
  const s = first.kernel.start({ cwd: 'C:\\work', title: 'starred' });
  await first.call('LocalSessions', 'updateSession', s.sessionId, { isStarred: true });
  first.kernel.flush();

  const second = makeBridge({ storePath });
  assert.equal(second.kernel.getSession(s.sessionId).isStarred, true);
});

test('unstarring also persists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'star-'));
  const storePath = path.join(dir, 'kernel-sessions.json');

  const first = makeBridge({ storePath });
  const s = first.kernel.start({ cwd: 'C:\\work' });
  await first.call('LocalSessions', 'updateSession', s.sessionId, { isStarred: true });
  await first.call('LocalSessions', 'updateSession', s.sessionId, { isStarred: false });
  first.kernel.flush();

  const second = makeBridge({ storePath });
  assert.equal(second.kernel.getSession(s.sessionId).isStarred, false);
});

test('a synthetic id does not create a phantom session', async () => {
  // The renderer sends updateSession for "local_star-sync-notice", which is NOT a real
  // session — it is a notice keyed by that id. A handler that created a record on demand
  // would add a nameless row to the sidebar every time the notice fired.
  const { kernel, call } = makeBridge();
  kernel.start({ cwd: 'C:\\work' });
  const before = kernel.getAll().length;

  const answer = await call('LocalSessions', 'updateSession', 'local_star-sync-notice', {
    isStarred: false,
  });

  assert.equal(answer, null, 'an unknown session must answer null');
  assert.equal(kernel.getAll().length, before, 'no record may be created');
  assert.equal(
    kernel.getAll().some((s) => s.sessionId === 'local_star-sync-notice'),
    false
  );
});

test('updateSession does not move lastActivityAt', async () => {
  // Renaming is not message activity; the sidebar groups by lastActivityAt, so
  // bumping it would reorder the list on a rename.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  const before = kernel.getSession(s.sessionId).lastActivityAt;
  await new Promise((r) => setTimeout(r, 15));
  await call('LocalSessions', 'updateSession', s.sessionId, { title: 'x' });
  assert.equal(kernel.getSession(s.sessionId).lastActivityAt, before);
});

test('updateSession ignores undefined values instead of erasing fields', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  await call('LocalSessions', 'updateSession', s.sessionId, { title: 'kept' });
  await call('LocalSessions', 'updateSession', s.sessionId, { title: undefined });
  assert.equal(kernel.getSession(s.sessionId).title, 'kept');
});

test('updateSession answers null for an unknown session', async () => {
  const { call } = makeBridge();
  assert.equal(await call('LocalSessions', 'updateSession', 'local_nope', { title: 'x' }), null);
});

test('updateSession emits session_updated so the sidebar refreshes', async () => {
  const { kernel, call, sent } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  sent.length = 0;
  await call('LocalSessions', 'updateSession', s.sessionId, { title: 'notify me' });

  // The event must arrive on the channel the preload actually subscribes to:
  // `onOnEvent` -> slice(2) -> "OnEvent".
  const evt = sent.find((m) =>
    m.channel.endsWith('_$_LocalSessions_$_OnEvent')
    && m.payload
    && m.payload.type === 'session_updated'
    && m.payload.sessionId === s.sessionId);
  assert.ok(evt, 'a rename must notify the renderer');
  assert.equal(evt.payload.session.title, 'notify me');
});

test('archive and unarchive toggle isArchived', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });

  await call('LocalSessions', 'archive', s.sessionId, { cleanupWorktree: true });
  assert.equal(kernel.getSession(s.sessionId).isArchived, true);

  await call('LocalSessions', 'unarchive', s.sessionId);
  assert.equal(kernel.getSession(s.sessionId).isArchived, false);
});

test('loadArchivedSessions lists only archived sessions', async () => {
  // Answering a constant empty object left the archive view empty even once
  // archiving worked.
  const { kernel, call } = makeBridge();
  const keep = kernel.start({ cwd: 'C:\\work' });
  const gone = kernel.start({ cwd: 'C:\\work' });
  await call('LocalSessions', 'archive', gone.sessionId);

  const listed = await call('LocalSessions', 'loadArchivedSessions');
  assert.ok(Array.isArray(listed.sessions));
  const ids = listed.sessions.map((x) => x.sessionId);
  assert.ok(ids.includes(gone.sessionId), 'archived session must be listed');
  assert.equal(ids.includes(keep.sessionId), false, 'active session must not be listed');
});

test('delete removes the session and its transcript', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\work' });
  kernel.getTranscript(s.sessionId).push({ type: 'user', message: { role: 'user', content: [] }, uuid: 'u' });

  const result = await call('LocalSessions', 'delete', s.sessionId);
  assert.equal(result.ok, true);
  assert.equal(kernel.getSession(s.sessionId), null);
  assert.equal(kernel.getTranscript(s.sessionId).length, 0);
});

test('a rename survives a restart through the store', async () => {
  // The mutators write through the same persistence path as everything else, so a
  // rename must be on disk, not only in memory.
  const { mkdtempSync, readFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const nodePath = require('node:path');
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'kernel-store-'));
  const storePath = nodePath.join(dir, 'kernel-sessions.json');

  const make = () => createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });

  const first = make();
  const s = first.start({ cwd: 'C:\\work' });
  first.update(s.sessionId, { title: 'persisted name' });
  first.flush();

  const onDisk = JSON.parse(readFileSync(storePath, 'utf8'));
  const saved = onDisk.sessions.find((x) => x.sessionId === s.sessionId);
  assert.equal(saved.title, 'persisted name');

  const second = make();
  assert.equal(second.getSession(s.sessionId).title, 'persisted name');
});
