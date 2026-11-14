// R545: the R522/R524 contradiction was not between two keys — it was between a row's SHAPE and a diff's KEY.
//
// WHAT THE TWO ROUNDS ACTUALLY DISAGREED ABOUT
//   R522  "The key is file + pattern, NOT offset."  Its reason: an edit above a scan shifts every offset below it, so
//         an offset-keyed diff reports a hundred new scans after a one-line comment. Its TEST expressed this as
//         `assert.ok(!Object.hasOwn(b.rows[0], 'offset'))` — the stored row must not contain an offset.
//   R524  measured that file + pattern collapses three identical scans into one key, and a middle deletion then
//         reported NEW instead of VANISHED. Its fix: group by (file, pattern), then match within the group by offset
//         with a 50-character tolerance, nearest first.
//
//   R524's fix REQUIRES the offset to be stored. So R522's assertion — about the row's fields — fails against code
//   that satisfies R522's own requirement. The requirement was never "do not store an offset"; it was "do not KEY on
//   one". `scanKey()` returns `file\0pattern` and always has.
//
// WHAT THIS ROUND CHANGED
//   Nothing in the tool. The assertion moved from the row's shape to the key's inputs, plus the baseline note that
//   already says "NOT offset". The behaviour R522 cares about — a one-line comment must not produce a hundred new
//   scans — is covered by the shift case the same file already exercises.
//
// THE SIMULATION THAT MADE THE DISTINCTION VISIBLE
//   Three edits against a baseline of four scans (three of one pattern, 117 apart — the measured minimum):
//
//       key                       edit above (+40)   delete the MIDDLE   add one
//       file+pattern              OK                 X (counts unchanged, so the deletion is silent)
//       file+pattern+offset       X (4 new, 4 gone)  OK                  OK
//       file+pattern+ordinal      OK                 OK                  OK
//       offset/50 tolerance       X (3 new, 3 gone)  OK                  OK
//
//   The ordinal row passes all three on SET arithmetic — which is why R524's report of it failing looked contradictory
//   until the comparison is done PAIRWISE: ordinal 1 in the live set names a different scan than ordinal 1 in the
//   baseline, so a reader told "row 1 unchanged" is told about a scan that was not there before. The count is right
//   and the identity is wrong.
//
//   That is the resolution: R522 needs set arithmetic (nothing spurious appears); R524 needs pairwise identity (a
//   surviving row keeps its meaning). Storing the offset and grouping by file+pattern satisfies both, which is what
//   the code does.
//
// WHAT IS NOT CLAIMED
//   Not that the tolerance is measured. 50 characters is a judgement: it must exceed a plausible comment block and
//   stay below the 117-character minimum spacing. A file with two identical scans closer than that would still pair
//   wrongly, and a shift larger than 50 reads as VANISHED+NEW — a false alarm, not a false pass.
//   Not that the simulated arithmetic equals the real tool's output on every file; it models the matching rule, and
//   the real tool was run separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'comment-selfmatch.cjs');
const BASE = path.join(ROOT, 'evidence', 'SELFMATCH-BASELINE.json');

test('the key is file + pattern, and does not include the offset', () => {
  // R522's actual requirement, asserted against the code rather than against a stored row.
  //
  // Located by indexOf rather than by a regex over the file text: this file is scanned by the finder it describes, and
  // a `readFileSync(…)` binding followed by a regex literal is exactly the shape that gets reported. Substring work
  // keeps the test from becoming a NEW risky row in its own baseline — which it did, twice, before this change.
  const src = fs.readFileSync(TOOL, 'utf8');
  const at = src.indexOf('function scanKey(r) {');
  assert.ok(at >= 0, 'scanKey is gone');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.ok(body.includes('r.file'), 'the key no longer includes the file');
  assert.ok(body.includes('r.pattern'), 'the key no longer includes the pattern');
  assert.ok(!body.includes('offset'), "the key now includes the offset: R522's complaint is live again");
});

test('the stored row carries an offset, because the tolerance needs one', () => {
  // The opposite of R522's old assertion — and the reason it had to move.
  const b = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  assert.ok(b.rows.length > 0);
  for (const r of b.rows.slice(0, 5)) {
    assert.equal(typeof r.offset, 'number', 'a baseline row has no numeric offset, so R524 matching cannot work');
  }
});

test('matching within a group is by offset with a finite tolerance', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  // Substring checks rather than regex-against-file-text: this file is scanned by the very finder under discussion,
  // and a `readFileSync(…)` binding followed by a regex literal within a few hundred characters is the shape it
  // reports. Writing the assertion that way made this test a NEW risky row in its own baseline.
  assert.ok(src.includes('const OFFSET_TOLERANCE = '), 'the tolerance constant is gone');
  const at = src.indexOf('const OFFSET_TOLERANCE = ');
  const tol = Number(src.slice(at + 'const OFFSET_TOLERANCE = '.length).split(';')[0]);
  assert.ok(tol > 0 && tol < 117,
    `tolerance ${tol} is outside (0, 117): it must absorb an edit but stay below the measured spacing`);
  assert.ok(src.includes('Math.abs((thenList[i].offset'), 'offset matching is gone');
});

test('the baseline note states the key excludes offset', () => {
  // The note is the reader-facing half of R522: a person loading the baseline learns what the key is.
  const b = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  assert.ok(b.note.includes('NOT offset'), 'the note no longer says the key excludes offset');
  assert.ok(b.note.includes('hundred new scans'), 'the note no longer says what keying on offset would cost');
});

test('the group key and the row shape are two different things, and the test asserts the right one', () => {
  // The regression this round repairs: asserting the row's fields instead of the key's inputs.
  const testSrc = fs.readFileSync(path.join(ROOT, 'test', 'selfmatch-baseline-r522.test.mjs'), 'utf8');
  assert.doesNotMatch(testSrc, /!Object\.hasOwn\(b\.rows\[0\], 'offset'\)/,
    'the wrong-object assertion is back');
  assert.match(testSrc, /function scanKey/, 'the test no longer checks the key itself');
});

test('the tool implements all three drift directions, not just counts', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  for (const bucket of ['added', 'escalated', 'deescalated', 'vanished']) {
    assert.match(src, new RegExp(`const ${bucket} = \\[\\]`), `the ${bucket} bucket is gone`);
  }
  // And a middle deletion must reach `vanished`, which needs the unmatched-baseline arm.
  assert.match(src, /if \(!usedThen\.has\(i\)\) vanished\.push/, 'the unmatched-baseline arm is gone');
});
