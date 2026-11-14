// Quitting must write the session store, or the last edit is silently lost.
//
// Mutations are coalesced behind a 50 ms timer (session-kernel.cjs `save()`), so the last
// change of a session lives only in memory until that timer fires. Measured this round:
//
//   flushKernel was referenced in exactly two places:
//     bridge-services.cjs  where it is defined
//     main.cjs:767         inside the $diag$_kernel_write diagnostic channel
//
// Nothing on the quit path called it. The `before-quit` handler released the tray, the
// terminal panes, the bridge, consent and the HTTP server — but never flushed the kernel.
// Quitting within 50 ms of a rename discarded the rename.
//
// Order matters twice over: the flush must come BEFORE dispose() (the bridge owns the
// kernel), and it must not be allowed to block quitting, hence the try/catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

test('the quit path flushes the kernel store', () => {
  assert.match(MAIN, /bridge\?\.flushKernel\?\.\(\)/, 'before-quit does not flush the kernel');
});

test('the flush happens before the bridge is disposed', () => {
  // dispose() tears down the object that owns the kernel; a flush after it is too late.
  const quitAt = MAIN.indexOf("app.on('before-quit'");
  const flushAt = MAIN.indexOf('bridge?.flushKernel?.()', quitAt);
  const disposeAt = MAIN.indexOf('bridge?.dispose()', quitAt);
  assert.ok(quitAt > 0 && flushAt > quitAt, 'no flush inside before-quit');
  assert.ok(disposeAt > flushAt, 'the bridge is disposed before the store is flushed');
});

test('a flush failure cannot prevent quitting', () => {
  // A full disk at shutdown must not leave the app hanging; the catch is load-bearing.
  const flushAt = MAIN.indexOf('bridge?.flushKernel?.()');
  const around = MAIN.slice(Math.max(0, flushAt - 120), flushAt + 120);
  assert.match(around, /try \{|best effort/, 'the flush is not guarded');
});

test('a pending write is what the flush is for', async () => {
  // The behaviour the guard protects: mutate, do not wait, flush, and the change is on disk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quit-flush-'));
  const storePath = path.join(dir, 'store.json');
  try {
    const kernel = createSessionKernel({
      emit: () => {},
      log: () => {},
      storePath,
      createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } }),
    });
    const session = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(session.sessionId, 'x');
    kernel.update(session.sessionId, { title: 'last-second-edit' });
    kernel.flush();
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const record = (stored.sessions || []).find((row) => row.sessionId === session.sessionId);
    assert.equal(record.title, 'last-second-edit', 'the flush did not persist the pending edit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('a renderer crash also flushes the store', () => {
  // The renderer is the side that requests changes; when it dies, the kernel still holds the
  // last 50 ms of edits. Nobody will press anything before the window reloads, so this path
  // needs the same flush as the quit path — measured: before this, render-process-gone only
  // logged and the pending write was lost.
  const at = MAIN.indexOf("on('render-process-gone'");
  assert.ok(at > 0, 'the render-process-gone handler is gone');
  const block = MAIN.slice(at, at + 1200);
  assert.match(block, /bridge\?\.flushKernel\?\.\(\)/, 'a renderer crash does not flush the store');
});

test('both crash and quit flush through the same guarded call', () => {
  // One spelling means one thing to fix if the API changes.
  const calls = [...MAIN.matchAll(/bridge\?\.flushKernel\?\.\(\)/g)];
  assert.ok(calls.length >= 2, 'expected a flush on both the quit and crash paths, found ' + calls.length);
});
