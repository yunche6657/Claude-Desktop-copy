// A store that cannot be written must tell the renderer, not fail silently.
//
// Measured before the fix: a blocked store path logged two lines and emitted NO event. The
// turn completed normally, so the user had every reason to believe it was saved — and found
// the conversation gone after a restart.
//
// After the fix, with the store path replaced by a directory (writes fail):
//   events: persist_failed (once, with reason and path)
//   turn rows: 2   (the conversation still works)
//   second failed flush: still 1 event   (deduplicated)
//   unblock + new save: persist_recovered (once), store valid JSON
//
// Deduplication matters: a full disk must not produce one event per keystroke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** A kernel whose store path is a directory, so every write throws. */
function blockedKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-store-'));
  const storePath = path.join(dir, 'store.json');
  fs.mkdirSync(storePath);
  const events = [];
  const kernel = createSessionKernel({
    emit: (event) => events.push(event),
    log: () => {},
    storePath,
    createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } }),
  });
  return { dir, storePath, events, kernel, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a failed write emits persist_failed with a reason', async () => {
  const w = blockedKernel();
  try {
    const session = w.kernel.start({ cwd: ROOT });
    await w.kernel.sendMessage(session.sessionId, 'x');
    w.kernel.flush();
    const failures = w.events.filter((event) => event.type === 'persist_failed');
    assert.equal(failures.length, 1, 'no persist_failed event was emitted');
    assert.ok(failures[0].reason, 'the event carries no reason');
    assert.ok(failures[0].path, 'the event does not say which store failed');
  } finally { w.cleanup(); }
});

test('the conversation still works while persistence is broken', async () => {
  // Blocking the turn would be worse than losing the save: the user cannot work at all.
  const w = blockedKernel();
  try {
    const session = w.kernel.start({ cwd: ROOT });
    await w.kernel.sendMessage(session.sessionId, 'still works');
    const rows = w.kernel.getTranscript(session.sessionId);
    assert.ok(Array.isArray(rows) && rows.length >= 2, 'the turn produced no transcript');
  } finally { w.cleanup(); }
});

test('a second failed write does not repeat the event', async () => {
  // Otherwise a full disk produces one event per mutation, which is its own kind of failure.
  const w = blockedKernel();
  try {
    const session = w.kernel.start({ cwd: ROOT });
    await w.kernel.sendMessage(session.sessionId, 'first');
    w.kernel.flush();
    await w.kernel.sendMessage(session.sessionId, 'second');
    w.kernel.flush();
    const failures = w.events.filter((event) => event.type === 'persist_failed');
    assert.equal(failures.length, 1, 'the failure event was repeated');
  } finally { w.cleanup(); }
});

test('a later successful write emits persist_recovered', async () => {
  const w = blockedKernel();
  try {
    const session = w.kernel.start({ cwd: ROOT });
    await w.kernel.sendMessage(session.sessionId, 'x');
    w.kernel.flush();
    assert.equal(w.events.filter((e) => e.type === 'persist_failed').length, 1);

    // Unblock, then make a change so the writer runs again.
    fs.rmSync(w.storePath, { recursive: true, force: true });
    w.kernel.update(session.sessionId, { title: 'after-recovery' });
    w.kernel.flush();

    assert.equal(w.events.filter((e) => e.type === 'persist_recovered').length, 1,
      'recovery was not announced');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(w.storePath, 'utf8')),
      'the store is still not valid JSON after recovery');
  } finally { w.cleanup(); }
});
