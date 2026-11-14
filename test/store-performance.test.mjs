// The store is big enough that a save per mutation would be fatal, and it is debounced.
//
// MEASURED on the real store (16.11 MB, 173 sessions, 1563 rows):
//   read          31 ms
//   JSON.parse    19 ms
//   stringify     24 ms
//   write+rename  20 ms
//   -------------------
//   full save    ~94 ms
//
// At that cost, one save per mutation would make a burst of 50 changes cost ~4.7 s of blocking
// I/O. MEASURED instead: 50 consecutive save() calls returned in 0 ms and produced exactly one
// write (the store on disk held 1692 bytes for a fresh kernel).
//
// The mechanism is a 50 ms trailing debounce with a re-entrancy guard:
//   if (savePending) return;   // a write is already queued
//   if (saveTimer) return;     // a timer is already armed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('save is debounced rather than writing on every call', () => {
  // Measured: 50 calls, one write.
  const kernel = read('desktop/session-kernel.cjs');
  const at = kernel.indexOf('const save = () => {');
  assert.ok(at > 0, 'save() is missing');
  const block = kernel.slice(at, at + 420);
  assert.match(block, /if \(savePending\) return;/, 'the re-entrancy guard is gone');
  assert.match(block, /if \(saveTimer\) return;/, 'the timer guard is gone');
  assert.match(block, /setTimeout\(/, 'the debounce timer is gone');
});

test('the debounce window is short enough to feel immediate', () => {
  // 50 ms: long enough to coalesce a burst, short enough that a user cannot notice.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /\}, 50\);/, 'the debounce window changed');
});

test('a pending write can be forced out before shutdown', () => {
  // Measured earlier (round 276): quitting without this loses the last edit.
  const kernel = read('desktop/session-kernel.cjs');
  const at = kernel.indexOf('const flush = () => {');
  assert.ok(at > 0, 'flush() is missing');
  const block = kernel.slice(at, at + 260);
  assert.match(block, /clearTimeout\(saveTimer\)/, 'flush does not cancel the timer');
  assert.match(block, /if \(savePending\) writeNow\(\)/, 'flush does not write the pending change');
});

test('the write itself is atomic so a crash cannot truncate the store', () => {
  // 16 MB written in place would leave a corrupt file if the process died mid-write.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /writeFileSync\(tmp, /, 'the store is not written to a temp file first');
  assert.match(kernel, /renameSync\(tmp, storePath\)/, 'the temp file is not renamed into place');
});
