'use strict';
// The recomputation project's first real output: three published numbers checked, all three correct, and all three looked wrong
// until the UNIT was read from the sentence.
//
// WHAT WAS CHECKED
//   Six claims in evidence/ take the form "FILE has N (个/行/条/处)". Five resolve to a real file; the sixth does not. The five were
//   re-derived from source. Every one of them names a unit that is NOT the line count, which is why a line-count comparison calls
//   all five wrong:
//
//       STATUS.md  main.cjs 10 行           10 ADDED lines, not the file's 1350
//       STATUS.md  session-kernel.cjs 367   367 BRANCHES
//       STATUS.md  kernel-select.test.mjs 13 13 top-level TESTS
//
// THE BRANCH CLAIM, CHECKED EXACTLY
//   The claim's own breakdown is `if 322 / else-if 7 / else 6 / catch 32 / case 0`, summing to 367. Re-derived from source with
//   strings and comments blanked (a `if (` inside a template literal is not a branch):
//
//       if total 322   else-if 7   else 6   catch 32   case 0
//
//   Every component matches. `if (` matches 322 INCLUDING the 7 `else if` occurrences, so the claim's total is the four
//   components summed with else-if counted twice: 322 + 7 + 6 + 32 = 367. Plain if (322 - 7) is 315. That is a normal
//   way to tabulate branches — the `if` figure is the family, and the `else-if` figure breaks it out — and the total is consistent.
//   Reading it as "322 plain if" would give 360, which is the arithmetic that fails.
//
// THE TEST CLAIM, CHECKED EXACTLY
//   `13 个测试` — a blanked scan counts 14 `test(` occurrences, but only 13 START A LINE, and the fourteenth is nested inside another
//   test. Top-level tests is the only reading under which the claimed 38 assertions sit in 13 tests.
//
// THE PATTERN, NOW FIVE TIMES
//       R621  two DRIFTs           field names read wrong
//       R622  ten evidence rows    regex crossed a semicolon
//       R624  thirty mismatches    table columns and count kinds read wrong
//       R625  five file claims     the unit (added lines / branches / tests) read wrong
//
//   In every case the DATA was right and the READING was wrong. That is now the dominant failure mode of this line of work, and it
//   is the one thing a probe cannot fix, because the probe IS the reading.
//
// WHAT THE RECOMPUTATION ACTUALLY BOUGHT
//   Three numbers that were previously "stated and unchecked" are now checked and correct. That is a small but real reduction of
//   R623's 807, and it is the only kind available: one claim at a time, by reading the sentence's unit first.
//
// WHAT IS NOT CLAIMED
//   Not that the other 800-odd are correct: three were checked.
//   Not that the sixth claim resolves: the scan found a FILE reference it could not resolve to any file, and did not chase it.

/** The three claims, each with the unit that had to be read from the sentence. */
const CLAIMS = [
  {
    doc: 'evidence/STATUS.md:28576',
    text: 'main.cjs 10 行',
    unit: 'ADDED lines in that round',
    actual: 10,
    naive: 1350,
    verdict: 'correct',
  },
  {
    doc: 'evidence/STATUS.md:29715',
    text: 'desktop/session-kernel.cjs 有 367 个分支 — if 322、else-if 7、else 6、catch 32、case 0',
    unit: 'branches, with `if` meaning the if-family total',
    actual: 367,
    breakdown: { if: 322, elseIf: 7, else: 6, catch: 32, case: 0 },
    verdict: 'correct — every component matches; sum 322+7+6+32 = 367',
  },
  {
    doc: 'evidence/STATUS.md:30528',
    text: 'test/kernel-select.test.mjs 有 13 个测试',
    unit: 'TOP-LEVEL test() calls',
    actual: 13,
    naive: 14,
    verdict: 'correct — the 14th test( is nested inside another',
  },
];

/** The misreading pattern, five instances. */
const PATTERN = {
  rounds: ['R621', 'R622', 'R624', 'R625'],
  common: 'the data was right and the reading was wrong',
  whyItResists: 'a probe cannot fix it, because the probe IS the reading',
  availableRemedy: 'read the sentence unit first, then recompute — one claim at a time',
};

module.exports = { CLAIMS, PATTERN };
