'use strict';
// What each detector GROUPS BY, and which of those keys has already been proved wrong.
//
// WHY THIS FILE EXISTS
//   Four detectors in this project failed the same way: the idea was right, the KEY was wrong.
//
//       R557  list-skeleton-divergence   keyed by member SET — flagged 31 of 31 groups because a fixture name used by
//                                        nineteen unrelated tests looked like nineteen spellings of one rule
//       R571  live-branch-audit          keyed by "is the name produced" — three wrong versions, withdrawn entirely
//       R574  strict-contract-audit      keyed by FIELD NAME — `ok` merged a Response property with a project return
//                                        value and became the top row
//       R575  strict-contract-audit      re-keyed by RECEIVER — better, but `b.isCurrent` still reports three phantom
//                                        reads because the pattern attributes a neighbouring property
//
//   Each was found by reading one row and asking whether it described the thing. Each cost a round. The point of recording
//   them is that the next detector can be checked against the list BEFORE it produces a work queue, rather than after.
//
// WHAT A "KEY" IS
//   The thing two findings must share to be considered the same finding. Get it wrong and unrelated things merge (R574) or
//   one thing fragments (R557's name-collision false positives were the opposite direction: unrelated things merged).
//
//   When a key is wrong, the symptom is always one of:
//       every item flagged      the key is so coarse that nothing can differ
//       the top row is absurd  the key merged two subjects that share only a name
//       three fixes, three new shapes
//                               the key is asking a question the text cannot answer (R571)
//
// WHAT THIS FILE IS NOT
//   It does not enforce anything. There is no test that fails when a new detector appears without an entry — that would be a
//   gate, and a gate invites a stub entry. What it offers is a question already answered four times, available to be read
//   before the fifth.
//
//   It also records judgement, and judgement is exactly what the four failures were about. A key cannot be checked
//   mechanically: the only test that found each wrong key was reading one row and asking whether it described the thing.

/**
 * One entry per detector, with the key it groups by and whether that key has been falsified.
 *
 * `status` values:
 *   sound          the key has been read against real rows and held
 *   falsified      the key was proved wrong; `lesson` says what replaced it or why it was withdrawn
 *   untested       the key has never been checked against a row — the most dangerous state, because it looks fine
 */
const DETECTOR_KEYS = [
  {
    tool: 'tools/list-skeleton-divergence.cjs',
    key: 'the surrounding statement skeleton, after removing member names and whitespace',
    status: 'falsified',
    round: 557,
    symptom: 'every group flagged (31 of 31)',
    lesson: 'A fixture name shared by nineteen unrelated tests is not one rule written nineteen ways. Narrowed with a '
      + 'leading-token filter and loop-variable normalisation: 31 -> 4. The narrowing has a cost, recorded at the tool: '
      + 'a real divergence that also changes the leading token is now hidden.',
  },
  {
    tool: 'tools/live-branch-audit.cjs',
    key: '"is the name this branch decides on produced elsewhere in the file"',
    status: 'falsified',
    round: 571,
    symptom: 'three fixes, three new defeating shapes, then withdrawal',
    lesson: 'This is a question about SCOPE, and answering it needs a parser. A same-line `const denied = …; if (denied)` '
      + 'broke the first version, a `catch (error)` binding broke the third, and the third flagged 356 of 3346 branches. '
      + 'Withdrawn; the tool now counts comments that witness a branch, which is a fact about documentation.',
  },
  {
    tool: 'tools/strict-contract-audit.cjs',
    key: 'FIELD NAME (first version)',
    status: 'falsified',
    round: 574,
    symptom: 'the top row was absurd — `ok`, 11 reads',
    lesson: '`response.ok` is a Response property typed by the platform; `{ ok: Boolean(updated) }` is a project object. '
      + 'One name, two fields. Re-keyed by RECEIVER.',
  },
  {
    tool: 'tools/strict-contract-audit.cjs',
    key: 'RECEIVER + FIELD',
    status: 'sound',
    round: 581,
    symptom: 'one row was wrong until R581: `b.isCurrent` reported 3 phantom reads',
    lesson: 'The pairing was CORRECT — `b` really is the receiver and `isCurrent` really is the field, and that held when '
      + 'the three rows were read. What was wrong was the CLASSIFICATION: the matched expression was '
      + '`typeof b.isCurrent === \'function\' && b.isCurrent() === true`, a type check followed by a strict call, not a '
      + 'truthiness read. Stripping `typeof x.f` and excluding a call form removed all three. R580 asked whether this was a '
      + 'regex defect or a type question; it was a regex defect, which is why the check stays a text scan instead of '
      + 'needing the parser R571 withdrew for.',
  },
  {
    tool: 'tools/duplicated-lists.cjs',
    key: 'SORTED MEMBER SET of a bracketed string literal',
    status: 'sound',
    round: 560,
    symptom: 'none — but two false positives were found and fixed inside it',
    lesson: 'A list inside a comment is not a site (R560) and a file that must name a list to describe it is not '
      + 'duplicating it (R560). Both were about SITE selection, not the key; the key — the set of members — has held '
      + 'against every row read since R553.',
  },
  {
    tool: 'tools/read-ledger.cjs',
    key: 'SORTED MEMBER SET, matching the detector above',
    status: 'sound',
    round: 561,
    symptom: 'no wrong row — but the ledger itself appeared as a site of the groups it records, and had to be excluded',
    lesson: 'The key has held because it is the same set the detector groups by, so an entry can only exist for a group '
      + 'that does. Keyed by members rather than by round, so a group whose contents change becomes a NEW unread entry — '
      + 'which is correct, because its new shape has not been read.',
  },
  {
    tool: 'tools/text-assertion-audit.cjs',
    key: '"does the assertion pattern contain a control keyword" — AND does it match code rather than data',
    status: 'sound',
    round: 582,
    symptom: 'the key was pattern-only, so `condition-coverage-r533:123` counted as control flow when its pattern matched a '
      + 'sentence stored in a `what:` data field',
    lesson: 'The pattern-only version was wrong in the same way as R574\'s field-name key: right mechanism, wrong subject. It '
      + 'has held since the subject was added — the discriminator was already in the repository, `lexer.blank()` replacing '
      + 'string literals and comments with whitespace, so a pattern that matches the raw text but not the blanked text matched '
      + 'only data. Measured on that row: raw true, blanked false. Control flow fell 19 -> 13, and 53 rows corpus-wide are now '
      + 'known to be data. Seven rows keep a pattern-only verdict because their subject cannot be resolved; those are reported '
      + 'as `subjectChecked: false` rather than guessed, since guessing a subject is the error this whole class of round is '
      + 'about.',
  },
  {
    tool: 'tools/group-provenance.cjs',
    key: '"does a site read the official bundle AND execute a slice"',
    status: 'sound',
    round: 563,
    symptom: 'first version keyed on "mentions an official path" — 9 groups; required execution too — 4',
    lesson: 'Reading without executing runs the original as a black box; executing without reading official material is a '
      + 'self-made fixture. Both halves are needed, and the four groups held when read.',
  },
  {
    tool: 'tools/proof-list-order.cjs',
    key: 'member ORDER at each proof-script site',
    status: 'sound',
    round: 559,
    symptom: 'first version counted its own comment as a site, and labelled every group order-critical',
    lesson: 'Both were site and predicate fixes. The key — order — held: the three scripts differ only in the last three '
      + 'names, and the loop body is `delete env[k]`, so the difference cannot matter.',
  },
  {
    tool: 'tools/detector-coverage.cjs',
    key: '"can this detector classify the site at all"',
    status: 'sound',
    round: 557,
    symptom: 'none — it is the tool that FOUND R557\'s 31-of-31 problem',
    lesson: 'A detector that reports zero findings is either right or blind, and this is the tool that distinguishes them.',
  },
];

/** The four failure symptoms, so a new detector can be checked against the shapes rather than the names. */
const FAILURE_SYMPTOMS = [
  { symptom: 'every item flagged', means: 'the key is so coarse nothing can differ' },
  { symptom: 'the top row is absurd', means: 'the key merged two subjects that share only a name' },
  { symptom: 'three fixes, three new defeating shapes', means: 'the key asks a question text cannot answer' },
  { symptom: 'the count barely moves when the rule changes', means: 'the key is not measuring what the rule does' },
];

module.exports = { DETECTOR_KEYS, FAILURE_SYMPTOMS };
