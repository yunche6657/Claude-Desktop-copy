// Forking a session — measured through the real bridge handler.
//
// MEASURED (temp store, real registerBridgeServices + kernel):
//
//   source 4 rows [user,assistant,user,assistant]
//   forkSession(src, null, null, null)
//     -> { sessionId: 'local_...', type: 'local', copiedMessages: 4 }
//     -> fork transcript 4 rows, same types
//     -> fork sessionId differs from the source
//
//   source 6 rows, forkSession(src, null, <uuid of row 2>, null)
//     -> copiedMessages: 2   and the fork holds exactly 2 rows
//
//   forkSession(src, null, 'no-such-uuid', null)
//     -> copiedMessages: 6   (an unknown anchor copies everything rather than nothing)
//
//   forkSession('local_missing', ...)
//     -> null               (refused, not a half-built session)
//
// The 'unknown anchor copies everything' behaviour is the interesting one: the alternative —
// copying nothing — would produce an empty fork the user did not ask for. Copying the whole
// conversation degrades to the plain-fork case, which is what the caller wanted minus the split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Build a kernel plus a callable bridge over it, with one session holding `turns` turns. */
async function makeForkable(turns) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-fork-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: 'ok', stopReason: 'end_turn' }; } }),
    storePath,
  });
  const handlers = new Map();
  registerBridgeServices({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`));
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  const s = kernel.start({ cwd: ROOT });
  for (let i = 0; i < turns; i++) await kernel.sendMessage(s.sessionId, 'turn ' + i);
  return { kernel, call, storePath, sourceId: s.sessionId };
}

test('forking copies the whole conversation into an independent session', async () => {
  const h = await makeForkable(2);
  try {
    const sourceRows = h.kernel.getTranscript(h.sourceId) || [];
    assert.equal(sourceRows.length, 4, 'the source did not record two turns');
    const forked = await h.call('LocalSessions', 'forkSession', h.sourceId, null, null, null);
    assert.ok(forked && forked.sessionId, 'fork returned no session');
    assert.notEqual(forked.sessionId, h.sourceId, 'the fork reused the source id');
    const forkRows = h.kernel.getTranscript(forked.sessionId) || [];
    assert.equal(forkRows.length, sourceRows.length, 'the fork did not copy every row');
    assert.deepEqual(forkRows.map((r) => r.type), sourceRows.map((r) => r.type), 'the fork changed the row types');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('forking at a message copies up to and including that row', async () => {
  const h = await makeForkable(3);
  try {
    const sourceRows = h.kernel.getTranscript(h.sourceId) || [];
    assert.equal(sourceRows.length, 6);
    const anchor = sourceRows[1].uuid;
    const forked = await h.call('LocalSessions', 'forkSession', h.sourceId, null, anchor, null);
    assert.ok(forked && forked.sessionId, 'fork returned no session');
    assert.equal(forked.copiedMessages, 2, 'copiedMessages is wrong: ' + forked.copiedMessages);
    assert.equal((h.kernel.getTranscript(forked.sessionId) || []).length, 2, 'the fork did not stop at the anchor');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('forking at an unknown message copies the whole conversation', async () => {
  // Copying nothing would hand the user an empty fork they did not ask for.
  const h = await makeForkable(3);
  try {
    const total = (h.kernel.getTranscript(h.sourceId) || []).length;
    const forked = await h.call('LocalSessions', 'forkSession', h.sourceId, null, 'no-such-uuid', null);
    assert.ok(forked && forked.sessionId, 'fork returned no session');
    assert.equal(forked.copiedMessages, total, 'an unknown anchor did not fall back to a full copy');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('forking an unknown session is refused', async () => {
  const h = await makeForkable(1);
  try {
    const forked = await h.call('LocalSessions', 'forkSession', 'local_does-not-exist', null, null, null);
    assert.equal(forked, null, 'forking a missing session produced something');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('the fork can be continued without touching the source', async () => {
  const h = await makeForkable(2);
  try {
    const forked = await h.call('LocalSessions', 'forkSession', h.sourceId, null, null, null);
    const sourceBefore = (h.kernel.getTranscript(h.sourceId) || []).length;
    await h.kernel.sendMessage(forked.sessionId, 'in the fork');
    assert.equal((h.kernel.getTranscript(forked.sessionId) || []).length, sourceBefore + 2, 'the fork did not grow');
    assert.equal((h.kernel.getTranscript(h.sourceId) || []).length, sourceBefore, 'the source grew with the fork');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});
