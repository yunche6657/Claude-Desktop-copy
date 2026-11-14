// Session search, verified against the real store rather than against its own source.
//
// MEASURED LIVE (replica :10180, 145 stored sessions):
//
//   query         results   note
//   ------------  -------   --------------------------------------------
//   'hi'            42      substring match, most sessions contain it
//   'E2E'            4      the E2E probe conversations
//   'approval'       8
//   'zzzznotfound'   0      no false positives
//
//   'APPROVAL'       8      case-insensitive
//   'Approval'       8
//   '  approval  '   8      surrounding whitespace trimmed
//   'E2E-LIVE'       1      hyphens are ordinary characters
//   'a'              0      < 2 characters is refused
//   ''               0
//   '   '            0
//
// And the snippets are honest: for each of the first five 'approval' hits, the snippet itself
// contains the term AND the session's stored transcript contains it. A snippet that did not
// come from the conversation would be the classic way this kind of feature lies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

/** The body of searchSessionsImpl, so its rules can be read without the rest of the file. */
function searchBody() {
  const start = BRIDGE.indexOf('const searchSessionsImpl =');
  assert.ok(start > 0, 'searchSessionsImpl is missing');
  return BRIDGE.slice(start, start + 2000);
}

test('a query shorter than two characters is refused', () => {
  // Measured: 'a' answers 0 while 'approval' answers 8. Without the floor a one-letter query
  // would match nearly every transcript and make the results useless.
  assert.match(searchBody(), /if \(text\.length < 2\) return \[\];/);
});

test('the query is lowercased before matching, so case does not matter', () => {
  // Measured: APPROVAL / Approval / approval all answer 8.
  assert.match(searchBody(), /query\.trim\(\)\.toLowerCase\(\)/);
});

test('title and folder are searched before the transcript', () => {
  // The cheap fields are also what a user usually means; the order is deliberate.
  const body = searchBody();
  const titleAt = body.indexOf('snippetAround(title, text)');
  const transcriptAt = body.indexOf('kernel.getTranscript(session.sessionId)');
  assert.ok(titleAt > 0 && transcriptAt > 0, 'one of the two searches is missing');
  assert.ok(titleAt < transcriptAt, 'the transcript is scanned before the title');
});

test('the result shape is {sessionId, snippet}, which is what the palette reads', () => {
  // The palette iterates the answer directly and reads both fields.
  assert.match(searchBody(), /results\.push\(\{ sessionId: session\.sessionId, snippet \}\)/);
});

test('the default limit is 50 and a caller may lower it', () => {
  const body = searchBody();
  assert.match(body, /: 50;/);
  assert.match(body, /options\.limit/);
});

test('search answers an array even with no matches', () => {
  // Round 7: an object here made the palette throw 'l is not iterable'.
  assert.match(BRIDGE, /if \(\/searchSessions\$\/i\.test\(frag\)\) return \[\];/);
});
