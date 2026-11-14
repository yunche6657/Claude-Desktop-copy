'use strict';
// Five of 24 evidence references are structurally broken: the line is not in the file. Two of those are character offsets
// written as line numbers — a mistake this round made and one earlier round copied.
//
// MEASURED, OUTSIDE STATUS.md
//       references                        24   (excluding one illustrative `foo.cjs:123` in prose)
//       file exists, line non-blank       19
//       line past EOF / blank              5
//       file missing                       0
//
// THE FIVE
//       ccb-kernel-wired.md         desktop/local-exec.cjs:87        blank line
//       ccb-permission-protocol.md  desktop/local-exec.cjs:87        blank line
//       conversation-r470.md        desktop/main.cjs:355             blank line
//       pure-key-r598.md            desktop/preview-access.cjs:2491  file has 127 lines
//       pure-key-r598.md            desktop/mcp-stdio-relay.cjs:1194  file has 85 lines
//
// WHAT THE TWO LARGE NUMBERS ARE
//   `2491` and `1194` are CHARACTER OFFSETS, not line numbers. They appear in R598 because that round's probes printed
//   `definition at char N`, and the write-up carried the number across with the colon syntax that means a line. The real lines are
//   22 and 14 — verified by finding `const key =` in each file.
//
//   That is the failure mode R617 described in the abstract: a coordinate looks precise, is checkable in principle, and is wrong in
//   a way no reader would catch without opening the file. The function NAME in the same sentence is still correct.
//
// WHY THE OTHER THREE ARE BLANK-LINE, NOT DRIFT
//   A citation that lands on a blank line usually means the code moved by a few lines, not that it was always wrong: `local-exec.cjs`
//   and `main.cjs` have both been edited since. That is drift, not error, and it is the price of citing a position in a live file.
//
//   The distinction matters for what to do: a wrong coordinate should be corrected, while drift is expected and argues for naming the
//   function instead. This round corrects the two offsets and does not attempt to re-locate the three drifted ones, because relocating
//   them would only reset the clock.
//
// WHAT IS NOT CLAIMED
//   Not that the 19 non-blank references point at the right thing: this round checked only that the line EXISTS, not that it says
//   what the document claims. R618's earlier spot-check found two more that exist and misdescribe (`run-tests.cjs:31` shows `/**`,
//   `tool-absence.cjs:49` shows a comment rather than `contractTools()`), and those are not counted here.
//   Not that 24 is the whole population: STATUS.md holds 13 more, and it is a running log where a stale coordinate is even likelier.

/** The measurement. */
const CENSUS = {
  population: 24,
  nonBlank: 19,
  broken: 5,
  missingFiles: 0,
  excluded: 1,
  excludedNote: 'one illustrative `desktop/foo.cjs:123` inside prose, not a real citation',
};

/** Each broken reference, with its kind. */
const BROKEN = [
  { doc: 'ccb-kernel-wired.md', target: 'desktop/local-exec.cjs:87', kind: 'blank-line', cause: 'drift' },
  { doc: 'ccb-permission-protocol.md', target: 'desktop/local-exec.cjs:87', kind: 'blank-line', cause: 'drift' },
  { doc: 'conversation-r470.md', target: 'desktop/main.cjs:355', kind: 'blank-line', cause: 'drift' },
  {
    doc: 'pure-key-r598.md',
    target: 'desktop/preview-access.cjs:2491',
    kind: 'past-eof',
    cause: 'character offset written as a line number',
    actualLine: 22,
    fileLines: 127,
  },
  {
    doc: 'pure-key-r598.md',
    target: 'desktop/mcp-stdio-relay.cjs:1194',
    kind: 'past-eof',
    cause: 'character offset written as a line number',
    actualLine: 14,
    fileLines: 85,
  },
];

/** Drift versus error, and why the response differs. */
const DISTINCTION = {
  drift: 'a citation landing on a blank line because the file was edited — expected in a live tree',
  error: 'a number that was never a line number — the offset/line confusion in R598',
  response: 'correct the error; for drift, prefer naming the function, since relocating only resets the clock',
};

module.exports = { CENSUS, BROKEN, DISTINCTION };
