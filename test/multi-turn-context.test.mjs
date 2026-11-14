// Multi-turn context: the live measurement, and one assertion with real discriminating power.
//
// THE MEASUREMENT (live, this round):
//   Session a5cf1d5f already held 4 rows from an earlier tool-approval probe:
//     user   "Use the Bash tool to run exactly: echo APPROVAL_PROBE_OK ..."
//     asst   tool_use Bash
//     user   tool_result
//     asst   "The command didn't run. The approval prompt timed out ..."
//   then asked: "How many messages have I sent in this conversation so far, counting this one?
//                Answer with just the number."
//   model answered: "2"
//   The session then held 6 rows (4 + the new question + its answer).
//
// 2 is the correct answer: two rows are text the user typed, the third user-role row is a
// tool_result. So the model saw the history, read it correctly, and excluded the tool row.
//
// SCOPE NOTE. Two earlier assertions in this file were removed after mutation testing:
//   - "tool_result appears in the kernel" survived a rename of that string,
//   - "rewindCore appears in the bridge" survived a rename too.
// Substring presence is not a property, and both properties are already covered better by
// tool-result-to-model.test.mjs, tool-transcript.test.mjs and checkpoint-surface.test.mjs.
// What remains here is the one assertion whose mutation genuinely turns it red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('a dispatched message carries an explicit session id', () => {
  // The measured turn landed in session a5cf1d5f specifically: rows went 4 -> 6 in that id,
  // and no other session grew. That is only possible if dispatch names the session instead of
  // letting the kernel guess (or create one).
  //
  // Mutation: replacing `sessionId` with `undefined` in every dispatch call turns this red.
  const dispatches = [...BRIDGE.matchAll(/kernel\.sendMessage\(([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(dispatches.length >= 2, 'expected dispatch calls to the kernel, found ' + dispatches.length);
  const withoutId = dispatches.filter((arg) => arg !== 'sessionId');
  assert.deepEqual(withoutId, [], 'a dispatch does not name its session: ' + withoutId.join(', '));
});

// (removed) "the kernel has a transcript API" survived renaming getTranscript, because the
// name appears in several places. Substring presence again — and the property is already
// covered by conversation-history.test.mjs and restart-state.test.mjs.
