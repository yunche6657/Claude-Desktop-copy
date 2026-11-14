'use strict';
// The drift model is refuted: coordinates do not decay with age. Of 15 STATUS.md citations, 4 are "broken" and only ONE of
// those is drift. The other three were never citations of a line at all.
//
// THE HYPOTHESIS AND ITS TEST
//   R618 closed by proposing that a running log accumulates stale coordinates, so older rounds should be likelier to be broken.
//   STATUS.md's 15 references span rounds 426, 470, 529, 550, 551, 562, 564, 577, 598, 601 and 617. Measured:
//
//       round  target                            verdict
//       426    tools/run-tests.cjs:31             ok
//       470    desktop/main.cjs:355               BROKEN — blank line, genuine drift
//       529    session-kernel.cjs:2474             ok
//       529    warm-idle-lifecycle.cjs:111         ok
//       550    session-kernel.cjs:2474             ok
//       551    runtime-tools.cjs:165               ok
//       551    tool-absence.cjs:49                 ok
//       562    mcp-session-auth.cjs:9              ok
//       562    mcp-plugin-session-auth-r378:24     ok
//       564    contract-union.cjs:24               ok
//       577    keep-awake-activity.cjs:6           ok
//       598    preview-access.cjs:2491             "broken" — a CHARACTER OFFSET
//       598    mcp-stdio-relay.cjs:1194            "broken" — a CHARACTER OFFSET
//       601    bridge-services.cjs:3714            ok
//       617    desktop/foo.cjs:123                 "broken" — an ILLUSTRATIVE PLACEHOLDER
//
//   The oldest citation (426) is fine and the newest real one (601) is fine. The breakage is at 470 and 598 — with no trend.
//
// WHY THE COUNT OF 4 IS REALLY A COUNT OF 1
//   Two of the four are the offset-as-line error R598 made and R618 corrected in the evidence document but not in STATUS.md — the
//   log still carries the wrong numbers because the log is append-only and earlier rounds are not edited.
//
//   One is `desktop/foo.cjs:123`, a placeholder R617 used in prose to mean "a citation looks like this". It is not a broken
//   citation; the regex cannot tell prose from reference.
//
//   So the genuine drift population is ONE citation in 15, and it is a blank line in a 1350-line file that has been edited many
//   times. The model "coordinates decay with age" predicts a slope; the data has a single point.
//
// WHAT THIS MEANS FOR THE PRACTICE
//   Naming a function is not merely more robust than citing a position — it is the only form that survives here. Twelve of fifteen
//   citations are correct, two are a different error entirely, one is not a citation, and one drifted. The rate is low enough that
//   citation is not the problem; the problem was a number that was never a line.
//
// WHAT IS NOT CLAIMED
//   Not that citing positions is safe: one in fifteen drifted in 259 rounds, and that citation's own sentence still names the
//   function, so the reader is not stranded.
//   Not that STATUS.md should be edited to fix the two offsets: it is an append-only log, and rewriting history to match current
//   line numbers would make the log disagree with the rounds it records.

/** The census, round by round. */
const ROWS = [
  { round: 426, target: 'tools/run-tests.cjs:31', verdict: 'ok' },
  { round: 470, target: 'desktop/main.cjs:355', verdict: 'drift' },
  { round: 529, target: 'desktop/session-kernel.cjs:2474', verdict: 'ok' },
  { round: 529, target: 'desktop/warm-idle-lifecycle.cjs:111', verdict: 'ok' },
  { round: 550, target: 'desktop/session-kernel.cjs:2474', verdict: 'ok' },
  { round: 551, target: 'tools/runtime-tools.cjs:165', verdict: 'ok' },
  { round: 551, target: 'tools/tool-absence.cjs:49', verdict: 'ok' },
  { round: 562, target: 'desktop/mcp-session-auth.cjs:9', verdict: 'ok' },
  { round: 562, target: 'test/mcp-plugin-session-auth-r378.test.mjs:24', verdict: 'ok' },
  { round: 564, target: 'tools/contract-union.cjs:24', verdict: 'ok' },
  { round: 577, target: 'desktop/keep-awake-activity.cjs:6', verdict: 'ok' },
  { round: 598, target: 'desktop/preview-access.cjs:2491', verdict: 'character-offset', realLine: 22 },
  { round: 598, target: 'desktop/mcp-stdio-relay.cjs:1194', verdict: 'character-offset', realLine: 14 },
  { round: 601, target: 'desktop/bridge-services.cjs:3714', verdict: 'ok' },
  { round: 617, target: 'desktop/foo.cjs:123', verdict: 'illustrative-placeholder' },
];

/** The model refuted. */
const MODEL = {
  hypothesis: 'a running log accumulates stale coordinates, so older rounds are likelier broken',
  data: 'broken at rounds 470 and 598; rounds 426, 529, 550, 551, 562, 564, 577, 601 all correct',
  verdict: 'refuted — there is no age trend, and the breakage has three different causes',
  genuineDrift: 1,
  correct: 11,
  offsetErrors: 2,
  placeholders: 1,
};

module.exports = { ROWS, MODEL };
