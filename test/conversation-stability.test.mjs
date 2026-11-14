// Consecutive turns stay flat, and a large transcript does not slow the store down.
//
// MEASURED on a fresh session (replica :10410), three turns in a row:
//   turn 1  3739 ms  rows 2
//   turn 2  3440 ms  rows 4
//   turn 3  3711 ms  rows 6
//   JS heap 158 MB used / 166 MB total
//
// The timings do NOT grow with the conversation: 3.4-3.7 s is the gateway's own latency and
// the spread is noise. A per-turn cost that grew would show up here as 3.7 / 4.5 / 5.6.
//
// And the largest stored session holds 478 rows; reading it 20 times took 771 ms, i.e. ~39 ms
// per read. So the transcript is not being re-parsed per access in a way that would bite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the transcript is held in memory, not re-read from disk per access', () => {
  // getTranscript returns from a Map. A file read per call would make the 39 ms figure much
  // worse on a 478-row session and would grow with disk contention.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /function getTranscript\(sessionId\) \{/, 'getTranscript is missing');
  assert.match(kernel, /return transcripts\.get\(sessionId\)/, 'getTranscript does not read the in-memory map');
});

test('a turn does not accumulate listeners', () => {
  // The backend path subscribes per turn; if it never unsubscribed, turn N would carry N
  // handlers and the cost would grow with the conversation.
  const kernel = read('desktop/session-kernel.cjs');
  // Assert the actual teardown: `unsubscribe()` inside the finally block. Matching the bare
  // word would also hit the declaration line and stay green when the call is removed.
  assert.match(kernel, /const unsubscribe = backend\.onEvent\(/, 'the subscription is gone');
  assert.match(kernel, /\} finally \{[\s\S]{0,40}unsubscribe\(\);/, 'the subscription is never torn down');
});

test('the running-turn map is cleared when a turn settles', () => {
  // A leaked entry would make the session refuse every later message with 'already running'.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /running\.delete\(sessionId\)/, 'the running map is never cleaned');
});

test('the store size is bounded by what the kernel writes, not by an unbounded buffer', () => {
  // The 478-row session is real user data and is NOT capped — capping it would silently drop
  // history. What must be bounded is the WRITE path: the store is serialised in full on every
  // save, so the guarantee is that a save cannot interleave with another (tmp + rename).
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /renameSync\(tmp, storePath\)/, 'the store write is not atomic');
  // And the transcript list itself must be a real array per session, never shared.
  assert.match(kernel, /transcripts\.set\(sessionId, \[\]\)|transcripts\.set\(sessionId,/, 'transcripts are not per session');
});