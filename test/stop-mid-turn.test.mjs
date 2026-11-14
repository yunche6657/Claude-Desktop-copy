// Cancelling a turn — verified by RUNNING a turn and cancelling it.
//
// WHY THIS FILE WAS REWRITTEN. It asserted on source text ('turnEntries is deliberately not
// written', 'the catch branch has a try block'). Those describe the code, not the outcome.
//
// MEASURED with an agent whose run() never settles until the signal aborts:
//
//   isRunning before cancel   true
//   cancel()                  { ok: true }
//   sendMessage settled       { ok: false, error: 'aborted by signal' }
//   isRunning after cancel    false
//   transcript rows           1, types ['user']    <- the prompt survives, no partial reply
//   events                    start, session_updated, turn_started, close, error
//
// The '1 row, user only' result is the design decision this file pins: a half-built assistant
// reply is deliberately NOT written, because a partial tool sequence would render as a broken
// conversation. The user's own message is always kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** A kernel whose turn hangs until it is cancelled. */
async function startHangingTurn() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-stop-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  const events = [];
  let reached = false;
  const kernel = createSessionKernel({
    createAgent: () => ({
      model: 'm',
      tools: [],
      run: (opts) => new Promise((_resolve, reject) => {
        reached = true;
        opts.signal.addEventListener('abort', () => reject(new Error('aborted by signal')));
      }),
    }),
    emit: (e) => events.push(e),
    storePath,
  });
  const s = kernel.start({ cwd: ROOT });
  const pending = kernel.sendMessage(s.sessionId, 'a long task');
  for (let i = 0; i < 60 && !reached; i++) await new Promise((r) => setTimeout(r, 25));
  return { kernel, pending, events, storePath, sessionId: s.sessionId, reached: () => reached };
}

test('cancelling a running turn reports success and settles the turn', async () => {
  const h = await startHangingTurn();
  try {
    assert.equal(h.reached(), true, 'the turn never started');
    assert.equal(h.kernel.getSession(h.sessionId).isRunning, true, 'the turn is not marked running');
    const cancelled = h.kernel.cancel(h.sessionId);
    assert.equal(cancelled.ok, true, 'cancel did not report success');
    const result = await h.pending;
    assert.equal(result.ok, false, 'the cancelled turn reported success');
    assert.match(String(result.error), /abort/i, 'the failure does not mention the abort');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('a cancelled turn clears isRunning so the session can be used again', async () => {
  const h = await startHangingTurn();
  try {
    h.kernel.cancel(h.sessionId);
    await h.pending;
    assert.equal(h.kernel.getSession(h.sessionId).isRunning, false, 'the session is stuck running');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('a cancelled turn keeps the user message and writes no partial reply', async () => {
  const h = await startHangingTurn();
  try {
    h.kernel.cancel(h.sessionId);
    await h.pending;
    const rows = h.kernel.getTranscript(h.sessionId) || [];
    assert.equal(rows.length, 1, 'expected only the user row, got ' + rows.length);
    assert.equal(rows[0].type, 'user', 'the surviving row is not the user message');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('a cancelled turn notifies the renderer', async () => {
  const h = await startHangingTurn();
  try {
    h.kernel.cancel(h.sessionId);
    await h.pending;
    const types = h.events.map((e) => e && e.type);
    assert.ok(types.includes('close'), 'no close event was emitted');
    assert.ok(types.includes('error'), 'no error event was emitted');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});
