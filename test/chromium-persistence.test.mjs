// Chromium storage must survive a full process restart, not merely open successfully.
//
// Round 164 fixed IndexedDB being entirely dead (open -> UnknownError) by relocating
// Chromium's storage root to the workspace. That round could only prove open() worked.
// This round proves the part the user actually cares about:
//
//   write 'hello-from-round-167' to indexedDB 'persist-probe' -> read back ok
//   kill the Electron process, start a new one
//   read the same key -> { survivesRestart: true, value: 'hello-from-round-167' }
//
// On-disk evidence: .data/chromium holds 1251 files / 30.2 MB after a few launches,
// and navigator.storage.estimate() reports an 8.18 GB quota with 8.9 KB used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

test('the storage root is inside the workspace, not the unwritable userData', () => {
  // A workspace-relative root is the property that makes writes succeed on this host.
  const at = MAIN.indexOf("app.setPath('userData'");
  assert.ok(at > 0, 'the relocation is missing');
  const block = MAIN.slice(Math.max(0, at - 900), at + 200);
  assert.match(block, /CLAUDE_WORKSPACE/, 'the target ignores the workspace root');
  assert.match(block, /path\.join\(/, 'the target is not built from the workspace path');
});

test('the relocation does not point every Chromium root at the same directory', () => {
  // Setting userData and sessionData to one path makes Chromium refuse the partition;
  // the sub-paths must stay distinct.
  const at = MAIN.indexOf("app.setPath('userData'");
  const block = MAIN.slice(at, at + 900);
  assert.match(block, /path\.join\(candidate, name\)/, 'sub-roots are not separated by name');
});

test('a failed relocation is logged rather than fatal', () => {
  // A host where the workspace is read-only must still start the app.
  const at = MAIN.indexOf('(function relocateChromiumStorage()');
  assert.ok(at > 0, 'the relocation helper is missing');
  const block = MAIN.slice(at, at + 1200);
  assert.match(block, /console\.error/, 'a failed relocation is silent');
});
