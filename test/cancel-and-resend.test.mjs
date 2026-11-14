// Cancelling a turn, then sending again immediately — verified by RUNNING both.
//
// MEASURED with a kernel whose first turn hangs until aborted and whose second turn answers
// normally:
//
//   isRunning before cancel   true
//   cancel()                  { ok: true }
//   isRunning after cancel    false
//   resend                    { ok: true, text: 'resent-ok' }
//   transcript rows           3, types ['user','user','assistant']
//
// The last line is the point: after a cancel the session accepts a new message and records
// both prompts plus the one reply that actually happened. Nothing from the cancelled turn is
// left behind as a fake assistant row.
//
// A FALSE ALARM worth recording (from the original live probe). It reported `cancelled: false`
// while the turn had visibly stopped, which looked like an interrupt that does not interrupt.
// The cause was timing — the turn had already finished on its own before the interrupt landed,
// so `false` was the honest answer. Cancelling while `isRunning` is definitely true returns
// `true`, which is what the test below pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** A kernel where turn 1 hangs until aborted and later turns answer at once. */
async function startThenCancel() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-resend-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  let calls = 0;
  const kernel = createSessionKernel({
    createAgent: () => ({
      model: 'm',
      tools: [],
      run: (opts) => {
        calls++;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        return Promise.resolve({ text: 'resent-ok', stopReason: 'end_turn' });
      },
    }),
    emit: () => {},
    storePath,
  });
  const s = kernel.start({ cwd: ROOT });
  const pending = kernel.sendMessage(s.sessionId, 'first');
  for (let i = 0; i < 60 && calls === 0; i++) await new Promise((r) => setTimeout(r, 25));
  return { kernel, pending, storePath, sessionId: s.sessionId };
}

test('cancel reports success while a turn is actually running', async () => {
  const h = await startThenCancel();
  try {
    assert.equal(h.kernel.getSession(h.sessionId).isRunning, true, 'the turn was not running');
    const cancelled = h.kernel.cancel(h.sessionId);
    assert.equal(cancelled.ok, true, 'cancel reported failure');
    await h.pending;
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('the session can send again immediately after a cancel', async () => {
  const h = await startThenCancel();
  try {
    h.kernel.cancel(h.sessionId);
    await h.pending;
    assert.equal(h.kernel.getSession(h.sessionId).isRunning, false, 'the flag was not cleared');
    const resent = await h.kernel.sendMessage(h.sessionId, 'second');
    assert.equal(resent.ok, true, 'the resend was refused');
    assert.equal(resent.text, 'resent-ok', 'the resend did not produce the expected reply');
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('a second message during a running turn is refused by name', async () => {
  // The double-turn guard is what makes the resend safe: without it two turns could write
  // to the same transcript concurrently. Measured message: 'a turn is already running'.
  const h = await startThenCancel();
  try {
    let refusal = null;
    try {
      await h.kernel.sendMessage(h.sessionId, 'while busy');
    } catch (e) {
      refusal = String(e.message);
    }
    assert.ok(refusal, 'a second concurrent turn was accepted');
    assert.match(refusal, /already running/, 'the refusal does not say why: ' + refusal);
  } finally {
    h.kernel.cancel(h.sessionId);
    try { await h.pending; } catch { /* aborted */ }
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});

test('the cancelled turn leaves no fake assistant row', async () => {
  const h = await startThenCancel();
  try {
    h.kernel.cancel(h.sessionId);
    await h.pending;
    await h.kernel.sendMessage(h.sessionId, 'second');
    const rows = h.kernel.getTranscript(h.sessionId) || [];
    assert.deepEqual(rows.map((r) => r.type), ['user', 'user', 'assistant'],
      'unexpected transcript shape: ' + JSON.stringify(rows.map((r) => r.type)));
  } finally {
    try { fs.unlinkSync(h.storePath); } catch { /* already gone */ }
  }
});