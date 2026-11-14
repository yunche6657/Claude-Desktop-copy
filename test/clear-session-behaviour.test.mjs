// Clearing a session and resuming it — measured through the real bridge handlers.
//
// MEASURED (temp store, real registerBridgeServices + kernel):
//
//   before clear     4 rows [user,assistant,user,assistant]
//   clearSession     { ok: true }
//   after clear      0 rows
//   send after clear works            (the session is not dead, just empty)
//   resumePreClearSession  { ok: true }
//   after resume     4 rows, content IDENTICAL to before
//   resume again     { ok: false, reason: 'nothing_to_resume' }
//
// Two properties matter here and neither is obvious from the code:
//   1. the restore is EXACT — the rows come back byte-for-byte, not a summary;
//   2. the second resume is REFUSED by name instead of silently re-restoring or clearing.
// A 'resume' that could run twice would either duplicate the transcript or do nothing while
// reporting ok, and both look like success.
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
async function makeClearable(turns) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-clear-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
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

test('clearing empties the transcript and reports success', async () => {
  const h = await makeClearable(1);
  try {
    assert.equal((h.kernel.getTranscript(h.sessionId) || []).length, 2, 'the turn did not record');
    const result = await h.call('LocalSessions', 'clearSession', h.sessionId);
    assert.equal(result.ok, true, 'clearSession did not report success');
    assert.equal((h.kernel.getTranscript(h.sessionId) || []).length, 0, 'the transcript was not emptied');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('a cleared session can still be used', async () => {
  // Clearing is not closing: the same session id keeps working.
  const h = await makeClearable(1);
  try {
    await h.call('LocalSessions', 'clearSession', h.sessionId);
    const res = await h.kernel.sendMessage(h.sessionId, 'fresh start');
    assert.equal(res.ok, true, 'the cleared session refused a new message');
    assert.equal((h.kernel.getTranscript(h.sessionId) || []).length, 2, 'the new turn did not record');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('resume restores the cleared transcript exactly', async () => {
  const h = await makeClearable(2);
  try {
    const before = h.kernel.getTranscript(h.sessionId) || [];
    const beforeJson = JSON.stringify(before);
    assert.equal(before.length, 4);
    await h.call('LocalSessions', 'clearSession', h.sessionId);
    const resumed = await h.call('LocalSessions', 'resumePreClearSession', h.sessionId);
    assert.equal(resumed.ok, true, 'resume did not report success');
    const after = h.kernel.getTranscript(h.sessionId) || [];
    assert.equal(after.length, before.length, 'the restored row count differs');
    assert.equal(JSON.stringify(after), beforeJson, 'the restored transcript is not identical');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('a second resume is refused by name, not silently repeated', async () => {
  // A resume that ran twice would either duplicate rows or do nothing while saying ok.
  const h = await makeClearable(1);
  try {
    await h.call('LocalSessions', 'clearSession', h.sessionId);
    const first = await h.call('LocalSessions', 'resumePreClearSession', h.sessionId);
    assert.equal(first.ok, true, 'the first resume failed');
    const second = await h.call('LocalSessions', 'resumePreClearSession', h.sessionId);
    assert.equal(second.ok, false, 'the second resume reported success');
    assert.equal(second.reason, 'nothing_to_resume', 'the refusal is not named: ' + JSON.stringify(second));
    assert.equal((h.kernel.getTranscript(h.sessionId) || []).length, 2, 'the second resume changed the transcript');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('resuming a session that was never cleared is refused', async () => {
  const h = await makeClearable(1);
  try {
    const result = await h.call('LocalSessions', 'resumePreClearSession', h.sessionId);
    assert.equal(result.ok, false, 'resuming a never-cleared session reported success');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});
