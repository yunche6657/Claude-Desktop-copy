// R546: nine guarded assertions, sorted into four that hid a harness failure and four where the skip is correct.
//
// THE RULE FOR SORTING THEM
//   A skip is CORRECT when "condition false" means the INPUT has nothing to assert about, and the test has already
//   established that the run was not empty. It is a HOLE when "condition false" means the TOOL or HARNESS failed to
//   produce something, because then a broken tool reads as a passing test.
//
// THE FOUR HOLES, AND WHAT EACH ONE HID
//   comment-selfmatch-explain-r521:109   `if (table && summary)` — if `--explain` stops printing either line, BOTH
//       regexes miss and the consistency check between them vanishes. The two values exist only to be compared.
//   not-logged-in-r481:99                `if (cap.exit)` — a missing exit record is a broken capture, and the clean
//       code 0 IS the observation this test documents (a silent exit).
//   porting-notes-r449:146               `if (m)` — the tool was already confirmed to exist and declare itself
//       read-only; a non-matching `async description() { … }` means the SHAPE changed, which is when the write-claim
//       check needs to run, not when it should stop.
//   sourcemap-exclusion-r462:140         `if (entries)` — reached only when win-unpacked has no app.asar, and if the
//       installer also cannot be listed the function returned with NEITHER the asar nor the archive checked.
//
// THE FOUR THAT ARE CORRECT (now listed in test-hygiene's REVIEWED set with the reason)
//   index-recall-r486:130        firstNonTitle === -1 means every row is a title hit: no boundary to place.
//   package-installer-r483:83    the condition is the environment's path having a space; the notice would be wrong
//                                to demand otherwise.
//   sourcemap-exclusion-r462:165 a non-junction ion-dist is a different legitimate layout.
//   tool-inventory-r487:114      status 0 is one of two documented outcomes.
//
// THE ONE THAT WAS NEVER A GUARD
//   installer-carries-patch-r479:101   `if (!fs.existsSync(deployed)) { assert.fail(…) }` — the body throws
//   unconditionally, so it cannot be passed through. The scanner matched the SHAPE `if (` + `assert.` without reading
//   that the assertion is `assert.fail`. Excluding `assert.fail` from the pattern is not a loosening: such a guard
//   still fails whenever its condition holds.
//
// WHAT IS NOT CLAIMED
//   Not that the remaining REVIEWED entries are all correct — the list predates this round and only the four added
//   here were examined. Not that the scanner now catches every hiding shape: it looks at the line after `if (`, so a
//   guard whose assertion is two lines down, or reached through a helper, is still invisible to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '../tools/guard-scan.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read a source file and report whether a guard-with-skip shape survives at roughly the old location. */
function source(file) {
  return fs.readFileSync(path.join(ROOT, 'test', file), 'utf8');
}

test('the four holes no longer skip when the value they need is missing', () => {
  // Each entry names its own old shape. The first version checked all four old shapes against every file, so the
  // assertion that fired was always about a file that was never expected to match it.
  const cases = [
    {
      file: 'comment-selfmatch-explain-r521.test.mjs',
      needs: ['assert.ok(table,', 'assert.ok(summary,'],
      // The old shape is quoted in the comment that explains the change, so the check requires it to be absent from
      // CODE. Matched with its `{` on the same line, which the quoted version does not have.
      gone: /\n\s+if \(table && summary\) \{/,
      label: 'both values guarded together',
    },
    {
      file: 'not-logged-in-r481.test.mjs',
      needs: ['assert.ok(cap.exit,'],
      gone: /if \(cap\.exit\) \{/,
      label: 'the exit record',
    },
    {
      file: 'porting-notes-r449.test.mjs',
      needs: ['assert.ok(m,'],
      gone: /if \(m\) \{\n\s+assert\.ok\(!WRITE_CLAIM/,
      label: 'the write-claim check',
    },
    {
      file: 'sourcemap-exclusion-r462.test.mjs',
      needs: ['assert.ok(entries,'],
      // Newline-anchored for the same reason as the r521 case: the old shape is quoted in the comment explaining it.
      gone: /\n\s+if \(entries\) \{/,
      label: 'the archive-entry check',
    },
  ];
  for (const c of cases) {
    const src = source(c.file);
    for (const need of c.needs) {
      assert.ok(src.includes(need), `${c.file} lost the assertion that replaced its guard: ${need}`);
    }
    assert.ok(!c.gone.test(src), `${c.file} still guards ${c.label}`);
  }
});

test('the hole at sourcemap-exclusion now fails when nothing was verified', () => {
  // The specific property: with no asar AND no installer listing, the test must fail rather than return green.
  const src = source('sourcemap-exclusion-r462.test.mjs');
  assert.match(src, /no app\.asar AND the installer could not be listed/,
    'the both-missing case is not described, so it may again pass silently');
});

test('the four correct skips are listed with their reasons', () => {
  const src = source('test-hygiene.test.mjs');
  for (const file of [
    'index-recall-r486.test.mjs',
    'package-installer-r483.test.mjs',
    'sourcemap-exclusion-r462.test.mjs',
    'tool-inventory-r487.test.mjs',
  ]) {
    assert.ok(src.includes(`'${file}'`), `${file} is not in the reviewed list`);
  }
  assert.match(src, /Reviewed R546/, 'the reviewed additions are not attributed to a round');
  assert.match(src, /skip means the INPUT has nothing to assert about/,
    'the rule used to classify them is not stated');
});

test('assert.fail is not counted as a guarded assertion', () => {
  // The scanner's own defect. A guard whose body throws unconditionally is an assertion, not a condition.
  //
  // The rule now lives in tools/guard-scan.cjs (R547 moved the detector out of the test file so it could be imported
  // rather than sliced), so the check follows it there instead of asserting against the call site's old shape.
  const detector = fs.readFileSync(path.join(ROOT, 'tools', 'guard-scan.cjs'), 'utf8');
  assert.match(detector, /assert\\\.\(\?!fail\\s\*\\\(\)/, 'the assert.fail exclusion is gone from the detector');
  // And behaviourally: a block whose only statement is `assert.fail` must not be reported.
  const r = scanText('test("x", () => {\n  if (!ok) {\n    assert.fail("no");\n  }\n});\n');
  assert.deepEqual(r.found, [], 'an assert.fail guard is reported as a hiding guard');
});

test('the round states which bodies it did not examine', () => {
  // The reviewed list is longer than the four added here, and only those four were looked at.
  const src = source('test-hygiene.test.mjs');
  assert.match(src, /The four HOLEs found in the same pass were removed rather than listed here/,
    'the round does not say the holes were removed rather than exempted');
});
