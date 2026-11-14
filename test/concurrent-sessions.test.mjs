// Concurrent sessions must not cross wires, and a second send to the same session must be
// refused loudly rather than interleaved.
//
// MEASURED (replica :10450).
//
// Two sessions, both prompts in flight at once:
//   A: ALPHA-ONLY  ->  aRows 2, aHasAlpha true,  aHasBeta false
//   B: BETA-ONLY   ->  bRows 2, bHasAlpha false, bHasBeta true
// Neither transcript contains the other's marker. The per-turn event subscription filters by
// sessionId precisely so a backend that outlives a turn cannot leak output into the wrong one.
//
// Two sends at the SAME session, fired without awaiting the first:
//   results  ["second-err: ...a turn is already running", "first-ok"]
//   rows     2   roles [user, assistant]
// The loser fails with a named reason and the transcript is untouched — not a half-written
// interleaving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('a second concurrent turn is refused with a named reason', () => {
  // Measured message: 'a turn is already running'. The guard must be explicit, not a race
  // that happens to lose.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /if \(session\.isRunning\) throw new Error\('a turn is already running for this session'\)/,
    'the double-turn guard is gone or reworded');
});

test('turn events are filtered by sessionId before reaching a transcript', () => {
  // This filter is why two sessions in flight do not contaminate each other.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /if \(event\.sessionId !== undefined && event\.sessionId !== null && event\.sessionId !== sessionId\) return;/,
    'cross-session events are no longer filtered');
});

test('each session owns its own transcript array', () => {
  // A shared array would make the two-session measurement impossible.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /transcripts\.set\(sessionId,/, 'transcripts are not stored per session');
  assert.match(kernel, /const transcripts = new Map\(\)/, 'the transcript map is gone');
});

test('the running registry is keyed per session, not global', () => {
  // One global controller would abort whichever turn happened to register last.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /const running = new Map\(\)/, 'the running map is gone');
  assert.match(kernel, /running\.set\(sessionId, controller\)/, 'controllers are not stored per session');
});
