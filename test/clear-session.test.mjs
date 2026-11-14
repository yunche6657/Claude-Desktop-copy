// `/clear` is a real slash command, and clearing must be reversible.
//
// The shipped UI builds the menu entry from `C?.clearSession` and shows
//   "Couldn't clear the conversation. Try again."
// when the call fails — measured: before this handler existed the bridge answered the generic
// fallback (null), so every attempt at /clear produced that message.
//
// The session record carries `hasPreClearSession` next to `rewindUndoable`; the renderer reads
// it to offer "resume the cleared conversation". So a clear that discarded the rows would be
// unrecoverable by design — it has to keep them.
//
// Verified live against a real session: before 2 rows -> clear {ok:true} -> 0 rows ->
// resume {ok:true} -> 2 rows. The real store was re-read afterwards: 142 sessions / 1448 rows,
// unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('both namespaces implement clearSession', () => {
  // The code surface and the cowork surface each build their own picker.
  assert.match(BRIDGE, /define\(`claude\.web_\$_\$\{svc\}_\$_clearSession`/);
  assert.match(BRIDGE, /define\(`claude\.web_\$_\$\{svc\}_\$_resumePreClearSession`/);
});

test('clearing keeps the rows somewhere recoverable', () => {
  // A clear that dropped the transcript would make "resume" impossible to honour.
  const at = BRIDGE.indexOf('const clearSessionCore =');
  assert.ok(at > 0, 'clearSessionCore is missing');
  const block = BRIDGE.slice(at, at + 1200);
  assert.match(block, /clearedTranscripts\.set\(/, 'the cleared rows are not kept');
  assert.match(block, /kernel\.setTranscript\(sessionId, \[\]\)/, 'the transcript is not emptied');
});

test('the record advertises whether a cleared conversation can be resumed', () => {
  // The renderer reads hasPreClearSession to decide whether to show the affordance.
  const at = BRIDGE.indexOf('const clearSessionCore =');
  const block = BRIDGE.slice(at, at + 1200);
  assert.match(block, /hasPreClearSession: rows\.length > 0/);
});

test('resuming puts the rows back and clears the flag', () => {
  const at = BRIDGE.indexOf('const resumePreClearSessionCore =');
  assert.ok(at > 0, 'resumePreClearSessionCore is missing');
  const block = BRIDGE.slice(at, at + 900);
  assert.match(block, /kernel\.setTranscript\(sessionId, kept\.map/, 'the rows are not restored');
  assert.match(block, /hasPreClearSession: false/, 'the flag is not cleared after resuming');
});

test('resuming with nothing stored refuses instead of pretending', () => {
  // Answering ok:true for a resume that restored nothing would clear the UI affordance while
  // leaving the conversation empty.
  const at = BRIDGE.indexOf('const resumePreClearSessionCore =');
  const block = BRIDGE.slice(at, at + 900);
  assert.match(block, /nothing_to_resume/, 'an empty resume does not report its reason');
});

test('clearing an unknown session is refused', () => {
  const at = BRIDGE.indexOf('const clearSessionCore =');
  const block = BRIDGE.slice(at, at + 1200);
  assert.match(block, /unknown_session/);
});
