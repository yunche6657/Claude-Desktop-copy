'use strict';
// A feature-flag id repeated across five files and fifteen sites, and no detector can see it.
//
// THE SHAPE THAT MADE THE GAP CONCRETE
//   R580 measured that 78% of replica-shaped test files never appear in a repeated-list group. R585 read one of them —
//   `test/cli-mcp-host-sources-r378.test.mjs` — to see what the list detectors miss, and found this:
//
//       '513873720'   test/cli-mcp-host-sources-r378.test.mjs           2 sites
//                     test/growthbook-cli-security-r378.test.mjs        8
//                     test/growthbook-cli-security-extra-r378.test.mjs  1
//                     desktop/cli-mcp-host-sources.cjs                  3
//                     desktop/growthbook-provider.cjs                   1
//
//   A GrowthBook flag id, fifteen sites, five files. No bracketed list is involved, so `duplicated-lists` never sees it and
//   `group-provenance` is never asked. The measured population of such ids:
//
//       513873720  5 files  15 uses        144321860  2 files  13 uses
//       17519066   4 files   8 uses        123929380  2 files   7 uses
//       879583975  2 files   4 uses        4122449738 2 files   3 uses
//       4041267332 2 files   2 uses        3990395613 2 files   2 uses
//
//   Eight ids, one of them in five files. That is a tractable set, and it exists outside every detector this project has.
//
// WHY A FLAG ID IS MORE DANGEROUS THAN A LIST TO DUPLICATE
//   A list duplicated with a typo is usually caught: the entry does not match, an assertion fails, a branch stops firing.
//   A flag id duplicated with a typo fails SILENTLY — a wrong id reads `undefined`, the gate reports "off", and the feature
//   that should have been enabled stays dark with no error anywhere. The failure mode is a missing behaviour, not a wrong one.
//
// WHY MOST OF THESE MUST NOT BE EXTRACTED
//   This is R563's reasoning applied to a string. `test/cli-mcp-host-sources-r378.test.mjs` exists to assert that the
//   PRODUCTION module reads the right flag; it has to name the same id to do that. Extract the id into a shared constant and
//   the test asserts that a constant equals itself — which it would, for any value.
//
//   So the count is not a to-do list. What it changes is where a reader looks: `desktop/cli-mcp-host-sources.cjs` has the id
//   at three sites (39, 50, 51, 60 — four, counting the comment) and a single typo among them would leave one of the two
//   observation paths watching a flag that does not exist while the other works.
//
// WHAT IS NOT CLAIMED
//   Not that any of the eight is currently mistyped — nothing here compares characters, it compares literal equality.
//   Not that eight is all of them: the scan requires a quoted literal of 6+ characters, so an id built by concatenation or
//   read from configuration is invisible.
//   Not that flag ids are the only container missed: function names repeated in two files showed 632 rows, which is why they
//   are not enumerated here — a set that large is not a finding.

/** Every pure-numeric id that appears in two or more files, measured. */
const FLAG_IDS = [
  { id: '513873720', fileCount: 5, uses: 15 },
  { id: '17519066', fileCount: 4, uses: 8 },
  { id: '144321860', fileCount: 2, uses: 13 },
  { id: '123929380', fileCount: 2, uses: 7 },
  { id: '879583975', fileCount: 2, uses: 4 },
  { id: '4122449738', fileCount: 2, uses: 3 },
  { id: '4041267332', fileCount: 2, uses: 2 },
  { id: '3990395613', fileCount: 2, uses: 2 },
];

/** The one with the most sites inside a single production module, where a typo is most costly. */
const WORST = {
  id: '513873720',
  productionFile: 'desktop/cli-mcp-host-sources.cjs',
  productionSites: 4,
  why: 'three code sites plus a comment; a typo at one of them leaves one observation path watching a flag that does not '
    + 'exist while the other keeps working, and nothing throws',
};

/** Why the count is not a work list. */
const WHY_NOT_EXTRACT = {
  rule: 'a flag id shared between a test and the code that owns the flag is deliberate duplication',
  reason: 'the test exists to assert the production module names the same id; extracting it would make the check agree with '
    + 'itself for any value',
  precedent: 'the same reasoning R563 used for replica-versus-original lists',
};

module.exports = { FLAG_IDS, WORST, WHY_NOT_EXTRACT };
