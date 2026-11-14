// Archiving flags a session; it never deletes it.
//
// MEASURED (replica :10470). Creating a session, sending a message, then archiving:
//
//   archive(sid)   -> { ok: true }
//   getAll()       -> still contains the session, count unchanged (171 -> 171)
//   isArchived     -> true
//   getTranscript  -> still readable, 2 rows
//
// That last part looks wrong until you read the handler: it calls
// applyPatch(sessionId, { isArchived: true }) and the comment says "the session is only
// flagged, never deleted". Filtering archived sessions out of the sidebar is the renderer's
// job, so the store deliberately keeps them.
//
// The distinction matters: an archive that deleted would lose the transcript, and 'unarchive'
// would have nothing to restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('archive sets isArchived rather than removing the session', () => {
  // Measured: { ok: true } and the record still present with isArchived: true.
  const bridge = read('desktop/bridge-services.cjs');
  const at = bridge.indexOf("define('claude.web_$_LocalSessions_$_archive'");
  assert.ok(at > 0, 'the archive handler is gone');
  const block = bridge.slice(at, at + 400);
  assert.match(block, /applyPatch\(sessionId, \{ isArchived: true \}\)/, 'archive no longer flags the session');
  assert.doesNotMatch(block, /delete\(sessionId\)/, 'archive deletes the session');
});

test('archive reports ok based on whether the patch applied', () => {
  // A handler returning a constant true would claim success for an unknown session.
  const bridge = read('desktop/bridge-services.cjs');
  const at = bridge.indexOf("define('claude.web_$_LocalSessions_$_archive'");
  const block = bridge.slice(at, at + 400);
  assert.match(block, /return \{ ok: Boolean\(updated\) \};/, 'the result is no longer tied to the patch');
});

test('unarchive is the exact inverse', () => {
  // Without it, an accidental archive would be permanent.
  const bridge = read('desktop/bridge-services.cjs');
  const at = bridge.indexOf("define('claude.web_$_LocalSessions_$_unarchive'");
  assert.ok(at > 0, 'the unarchive handler is gone');
  const block = bridge.slice(at, at + 400);
  assert.match(block, /applyPatch\(sessionId, \{ isArchived: false \}\)/, 'unarchive does not clear the flag');
});

test('archiving notifies the renderer so the sidebar can react', () => {
  // Measured: the flag changed without a reload, which requires the event.
  const bridge = read('desktop/bridge-services.cjs');
  const at = bridge.indexOf("define('claude.web_$_LocalSessions_$_archive'");
  const block = bridge.slice(at, at + 400);
  assert.match(block, /emitSessionEvent\(\{ type: 'session_updated'/, 'no update event is emitted');
});
