// A mutation run that is KILLED must not leave the source mutated.
//
// MEASURED FAILURE (round 350): a mutation script was terminated by a timeout while
// desktop/session-kernel.cjs was mutated. `finally { writeFileSync(file, original) }` did not
// run — a killed process executes no finally block — so the mutated source stayed on disk, and
// the file went from 53958 to 51216 bytes when a later step rewrote it from a partial read.
//
// The fix is not 'remember to restore'. It is to persist a backup before mutating and to repair
// from that backup on the NEXT run, because the recovery path must not depend on clean shutdown.
//
// MEASURED with the module below:
//   original 54497 bytes -> wrecked to 5000 -> recoverStale() -> 54497 bytes, byte-identical
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession, recoverStale, backupPathFor, verifySnapshot } from '../tools/mutation-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scratch(content = 'line one\nline two\nline three\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mutsess-'));
  const file = path.join(dir, 'source.mjs');
  fs.writeFileSync(file, content);
  return { dir, file, content, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('opening a session writes a backup next to the file', () => {
  const box = scratch();
  try {
    const session = openSession(box.file);
    assert.ok(fs.existsSync(backupPathFor(box.file)), 'no backup was written');
    assert.equal(fs.readFileSync(backupPathFor(box.file), 'utf8'), box.content);
    session.close();
  } finally { box.cleanup(); }
});

test('closing restores the original bytes and removes the backup', () => {
  const box = scratch();
  try {
    const session = openSession(box.file);
    fs.writeFileSync(box.file, 'MUTATED\n');
    session.close();
    assert.equal(fs.readFileSync(box.file, 'utf8'), box.content);
    assert.equal(fs.existsSync(backupPathFor(box.file)), false, 'the backup survived close()');
  } finally { box.cleanup(); }
});

test('a session that is never closed is repaired by the next run', () => {
  // This is the round-350 shape: the process dies with the file mutated and no close().
  const box = scratch();
  try {
    openSession(box.file); // deliberately not closed
    fs.writeFileSync(box.file, 'TRUNCATED');
    assert.notEqual(fs.readFileSync(box.file, 'utf8'), box.content, 'the scratch file was not actually damaged');

    const recovered = recoverStale(box.file);
    assert.equal(recovered.restored, true, 'the stale backup was not used: ' + JSON.stringify(recovered));
    assert.equal(fs.readFileSync(box.file, 'utf8'), box.content, 'the file was not restored byte-identically');
  } finally { box.cleanup(); }
});

test('recovering twice is safe and the second call is a no-op', () => {
  const box = scratch();
  try {
    openSession(box.file);
    fs.writeFileSync(box.file, 'TRUNCATED');
    assert.equal(recoverStale(box.file).restored, true);
    assert.equal(recoverStale(box.file).restored, false, 'a second recovery claimed to restore something');
    assert.equal(fs.readFileSync(box.file, 'utf8'), box.content);
  } finally { box.cleanup(); }
});

test('a clean file with no backup is left alone', () => {
  const box = scratch();
  try {
    const before = fs.readFileSync(box.file, 'utf8');
    assert.equal(recoverStale(box.file).restored, false);
    assert.equal(fs.readFileSync(box.file, 'utf8'), before);
  } finally { box.cleanup(); }
});

test('openSession repairs a stale backup before snapshotting the new one', () => {
  // Order matters: snapshotting first would overwrite the good copy with the damaged file.
  const box = scratch();
  try {
    openSession(box.file);
    fs.writeFileSync(box.file, 'DAMAGED');
    const session = openSession(box.file); // should repair, then snapshot the GOOD content
    session.close();
    assert.equal(fs.readFileSync(box.file, 'utf8'), box.content,
      'openSession snapshotted the damaged file instead of repairing first');
  } finally { box.cleanup(); }
});

test('verifySnapshot notices a file that changed underneath the session', () => {
  const box = scratch();
  try {
    const session = openSession(box.file);
    assert.equal(verifySnapshot(session).matches, true);
    fs.writeFileSync(box.file, 'someone else wrote this');
    const check = verifySnapshot(session);
    assert.equal(check.matches, false, 'a rewritten file still compared equal');
    assert.notEqual(check.bytes, check.expectedBytes);
    session.close();
  } finally { box.cleanup(); }
});

test('the real kernel file has no stale mutation backup left behind', () => {
  // A leftover backup means some earlier run died mid-mutation, and the file on disk may be
  // mutated. Fail here rather than let that state persist silently.
  const kernel = path.join(ROOT, 'desktop', 'session-kernel.cjs');
  const backup = backupPathFor(kernel);
  assert.equal(fs.existsSync(backup), false,
    'a stale mutation backup exists at ' + backup + ' — a mutation run died without restoring');
});
