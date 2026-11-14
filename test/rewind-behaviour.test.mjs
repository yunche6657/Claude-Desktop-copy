// Rewinding to a message — measured through the real bridge handler.
//
// MEASURED (temp store, real registerBridgeServices + kernel), 6 rows after three turns:
//
//   rewindV2(sid, uuid of row 2)  -> { prefill: 'ok' }
//   rows after                    2   (the target row is KEPT, later rows dropped)
//   kept uuids                    [row0.uuid, row1.uuid]
//
//   rewindV2(sid, 'no-such-uuid') -> { refusal: 'target_not_found' }
//   rewindV2(sid, null)           -> { refusal: 'missing_target' }
//   rewindV2('local_nope', 'x')   -> { refusal: 'unknown_session' }
//
// Three things this pins:
//   1. the answer is always an OBJECT — the shipped consumer destructures it, and the
//      original null fallback threw 'Cannot destructure property prefill of null';
//   2. the target row SURVIVES (rewind means 'remove this message and everything after it',
//      which is the shipped context menu's own wording), and the truncation is exact;
//   3. a near match is never guessed — an unknown uuid is refused, because rewinding to the
//      wrong row would silently destroy the conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** A kernel + callable bridge, with one session holding `turns` completed turns. */
async function makeRewindable(turns) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-rewind-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
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
  return { kernel, call, storePath, sessionId: s.sessionId };
}

test('rewind truncates the transcript and keeps the target row', async () => {
  const h = await makeRewindable(3);
  try {
    const rows = h.kernel.getTranscript(h.sessionId) || [];
    assert.equal(rows.length, 6, 'the seed did not record three turns');
    const target = rows[1];
    const result = await h.call('LocalSessions', 'rewindV2', h.sessionId, target.uuid);
    assert.equal(typeof result, 'object', 'rewind did not answer an object');
    assert.equal(result.refusal, undefined, 'rewind refused: ' + JSON.stringify(result));
    const after = h.kernel.getTranscript(h.sessionId) || [];
    assert.equal(after.length, 2, 'the transcript was not truncated to the target, got ' + after.length);
    assert.deepEqual(after.map((r) => r.uuid), [rows[0].uuid, target.uuid], 'the wrong rows were kept');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('rewind returns the truncated prompt as prefill', async () => {
  // The composer puts this back so the user can edit instead of retyping.
  const h = await makeRewindable(2);
  try {
    const rows = h.kernel.getTranscript(h.sessionId) || [];
    const userRow = rows.find((r) => r.type === 'user');
    const result = await h.call('LocalSessions', 'rewindV2', h.sessionId, userRow.uuid);
    assert.equal(typeof result.prefill, 'string', 'prefill is not a string: ' + JSON.stringify(result));
    assert.ok(result.prefill.length > 0, 'prefill is empty');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('rewind refuses an unknown message uuid instead of guessing', async () => {
  // A near match would silently destroy the conversation.
  const h = await makeRewindable(2);
  try {
    const before = (h.kernel.getTranscript(h.sessionId) || []).length;
    const result = await h.call('LocalSessions', 'rewindV2', h.sessionId, 'no-such-uuid');
    assert.equal(result.refusal, 'target_not_found', 'the refusal is wrong: ' + JSON.stringify(result));
    assert.equal((h.kernel.getTranscript(h.sessionId) || []).length, before, 'a refused rewind changed the transcript');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('rewind refuses a missing target and an unknown session', async () => {
  const h = await makeRewindable(1);
  try {
    const noTarget = await h.call('LocalSessions', 'rewindV2', h.sessionId, null);
    assert.equal(noTarget.refusal, 'missing_target', 'missing target is not named: ' + JSON.stringify(noTarget));
    const noSession = await h.call('LocalSessions', 'rewindV2', 'local_does-not-exist', 'x');
    assert.equal(noSession.refusal, 'unknown_session', 'unknown session is not named: ' + JSON.stringify(noSession));
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('the older rewind method answers the same object shape', async () => {
  // Two shipped call sites: rewindV2 destructures {prefill, refusal}, rewind reads {prefill}.
  const h = await makeRewindable(2);
  try {
    const rows = h.kernel.getTranscript(h.sessionId) || [];
    const result = await h.call('LocalSessions', 'rewind', h.sessionId, rows[0].uuid);
    assert.equal(typeof result, 'object', 'rewind answered a non-object');
    assert.ok('prefill' in result, 'rewind did not answer a prefill field');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});
