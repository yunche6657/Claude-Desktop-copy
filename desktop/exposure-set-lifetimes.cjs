'use strict';
// `seenFeatureExposure` deduplicates and is never cleared — while both sibling sets have a reset path. That is a difference
// in kind, not the same "unused machinery" story a third time.
//
// THE CENSUS
//       set                        has  add  delete  clear
//       seenFeatureExposure         1    1     0       0      ← never reset
//       seenExperimentExposure      1    1     1       1      ← delete on rejection (:81), clear on account switch (:260)
//       deferredExposure            —    1     —       2      ← clear after replay (:88) and on account switch (:261)
//
//   All three live in the same function, three lines apart, and two of them can be returned to their initial state. The first
//   cannot.
//
// WHY THAT MATTERS, CONCRETELY
//   The signature is `${key}:${item.on}:${item.source}` (:69). Two of those three components are properties of the FEATURE —
//   which key, whether it is on, where the value came from. None of them mentions the ACCOUNT.
//
//   So after an account switch, if the same flag is on from the same source for the new account, its signature is unchanged
//   and the exposure is suppressed. `seenExperimentExposure` is cleared on exactly that event (:260), which means the
//   experiment branch reports for the new account while the feature branch does not.
//
//   That asymmetry is visible in the source as two adjacent lines:
//
//       :260   if (lastAccount !== undefined && lastAccount !== context.accountKey) seenExperimentExposure.clear();
//       :261   lastAccount = context.accountKey; deferredExposure.clear();
//
//   The line between them clears a set unconditionally; the line before clears one only on a switch. The set that is never
//   cleared is the third one, and it is not mentioned here at all.
//
// WHAT THIS IS NOT
//   Not a claim that exposures are being lost in production. R587 established that no production caller supplies
//   `onExposure`, so nothing is reported either way today. The finding is about the mechanism's shape: when a reporter IS
//   wired, an account switch will suppress the first feature exposure per flag per account.
//
//   Not a claim that the suppression is wrong by intent. It may be deliberate — a feature exposure is arguably about the
//   flag being served, not about who received it. But if it were deliberate, the neighbouring experiment set would not need
//   a clear on the same event, and the two would not be declared on one line.
//
// WHY THIS IS THE THIRD SET BUT A DIFFERENT FINDING
//   R587 found `onExposure` absent (nothing is called). R588 found `deferredExposure` reachable but rare. Both were about
//   whether a path is travelled. This one is about two sets travelling DIFFERENT distances on the same event — which is
//   visible only by counting operations, not by asking whether the code runs.

/** Operation counts, measured by pattern, with the lines that produce them. */
const SETS = [
  {
    name: 'seenFeatureExposure',
    declared: 45,
    ops: { has: 1, add: 1, delete: 0, clear: 0 },
    lines: { has: [70], add: [71], delete: [], clear: [] },
    note: 'the dedup guard for feature exposures; never returned to its initial state',
  },
  {
    name: 'seenExperimentExposure',
    declared: 45,
    ops: { has: 1, add: 1, delete: 1, clear: 1 },
    lines: { has: [77], add: [78], delete: [81], clear: [260] },
    note: 'retried after a rejected queue (:81) and cleared when the account changes (:260)',
  },
  {
    name: 'deferredExposure',
    declared: 42,
    ops: { has: 0, add: 1, delete: 0, clear: 2 },
    lines: { has: [], add: [67], delete: [], clear: [88, 261] },
    note: 'cleared after replay (:88) and on account switch (:261)',
  },
];

/** The consequence, stated as a condition rather than a current defect. */
const CONSEQUENCE = {
  signatureAt: 69,
  signatureParts: ['key', 'item.on', 'item.source'],
  missingPart: 'the account — so the same flag from the same source produces the same signature across accounts',
  event: 'an account switch',
  effect: 'the first feature exposure per flag is suppressed for the new account, while the experiment exposure is '
    + 'reported because its set was cleared',
  live: false,
  why: 'no production caller supplies onExposure (R587), so nothing is reported either way today',
  whenItWouldMatter: 'a caller wiring onExposure',
};

module.exports = { SETS, CONSEQUENCE };

// THE ENUMERATION R591 ADDED
//   `tools/set-lifetimes.cjs` finds every `const NAME = new Set(` with at least one `has` and one `add` and no `delete` or
//   `clear`: 38 of them. That is not thirty-eight defects — most are ordinary caches whose key names the thing being cached
//   (`keptUuids` by uuid, `seenIds` by probe id, `known` by organization).
//
//   Nine sit in files that reset SOME set, which is the cheap heuristic and it over-reports: `scheduled-tasks.cjs` resets
//   `announced` while `seenWalls` keeps running, and the two are unrelated. `main.cjs` clears `hybridAuthResults` while
//   `askedOnce` keeps running — different domain entirely.
//
//   The real class is ONE, and the criterion is: the key omits a dimension, AND the event that changes that dimension clears
//   a SIBLING set fed by the same function. Only `seenFeatureExposure` satisfies both. Two of the 38 were read and dismissed
//   on the grounds above; the remaining 35 are unread, and the tool is the record rather than this note.
