// Deleting one session removes exactly that session — verified by RUNNING the kernel.
//
// WHY THIS FILE WAS REWRITTEN. It used to assert on source text ('remove() calls
// sessions.delete', 'no clear()'). Those assertions pass as long as the strings are present;
// a mutation that reversed a condition would not have been noticed. This version drives the
// real kernel and inspects the real state.
//
// MEASURED (temp store, two sessions, delete one):
//
//   remove(b)                -> { ok: true }
//   getAll() count           -> 2 -> 1
//   deleted session present  -> false
//   survivor transcript      -> 2 rows before, 2 rows after
//   deleted transcript       -> 0 rows
//   disk orphan transcripts  -> 0
//   remove(unknown id)       -> { ok: false }
//
// Persistence is DEBOUNCED, measured separately: immediately after remove the file still holds
// 2 sessions; 300 ms later it holds 1, and flush() forces it. That is the same 50 ms trailing
// debounce the store uses everywhere (a full save costs ~94 ms on the real 16 MB store), so a
// crash inside the window could resurrect the session — accepted, and the reason flush() exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function freshKernel() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-del-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'ok', stopReason: 'end_turn' }) }),
    emit: () => {},
    storePath,
  });
  return { kernel, storePath };
}

test('delete removes the session and its transcript, and spares the others', async () => {
  const { kernel, storePath } = await freshKernel();
  try {
    const a = kernel.start({ cwd: ROOT });
    const b = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(a.sessionId, 'keep me');
    await kernel.sendMessage(b.sessionId, 'delete me');
    const survivorBefore = (kernel.getTranscript(a.sessionId) || []).length;

    const removed = kernel.remove(b.sessionId);

    assert.equal(removed.ok, true, 'remove did not report success');
    assert.equal(kernel.getAll().length, 1, 'exactly one session should remain');
    assert.equal(kernel.getAll().some((s) => s.sessionId === b.sessionId), false, 'the deleted session is still listed');
    assert.equal((kernel.getTranscript(b.sessionId) || []).length, 0, 'the deleted transcript survived');
    assert.equal((kernel.getTranscript(a.sessionId) || []).length, survivorBefore, 'the survivor transcript changed');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('deleting an unknown session reports failure instead of success', async () => {
  const { kernel, storePath } = await freshKernel();
  try {
    const result = kernel.remove('local_does-not-exist');
    assert.equal(result.ok, false, 'a missing session was reported as deleted');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('the store is left with no orphan transcripts', async () => {
  const { kernel, storePath } = await freshKernel();
  try {
    const a = kernel.start({ cwd: ROOT });
    const b = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(a.sessionId, 'keep');
    await kernel.sendMessage(b.sessionId, 'drop');
    kernel.remove(b.sessionId);
    kernel.flush();
    const disk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const ids = new Set((disk.sessions || []).map((s) => s.sessionId));
    const orphans = Object.keys(disk.transcripts || {}).filter((k) => !ids.has(k));
    assert.deepEqual(orphans, [], 'transcripts outlived their sessions: ' + orphans.join(', '));
    assert.equal((disk.sessions || []).length, 1, 'the deletion did not reach disk after flush');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('a flush immediately after delete persists it', async () => {
  // Measured: without flush the file lags by one debounce window.
  const { kernel, storePath } = await freshKernel();
  try {
    const a = kernel.start({ cwd: ROOT });
    const b = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(a.sessionId, 'keep');
    await kernel.sendMessage(b.sessionId, 'drop');
    kernel.flush();
    const before = JSON.parse(fs.readFileSync(storePath, 'utf8')).sessions.length;
    kernel.remove(b.sessionId);
    kernel.flush();
    const after = JSON.parse(fs.readFileSync(storePath, 'utf8')).sessions.length;
    assert.equal(after, before - 1, 'flush did not persist the deletion');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});
