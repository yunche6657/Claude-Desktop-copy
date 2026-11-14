'use strict';
// R608's mask introduced a regression: reading the value from blanked text turned every string literal into whitespace, so
// 22 declarations classified as `unknown` where a literal must read `internal`. Found and fixed this round.
//
// THE BUG R608 CAUSED, NOT THE ONE IT WAS LOOKING FOR
//   R608 changed `assignments()` to match over `blank(text)` so that an assignment inside an injected script string would not
//   count. Correct. But it also read the VALUE from the same masked text:
//
//       const masked = blank(text);
//       for (const m of masked.matchAll(re)) { … provenance: provenance(m[1]) }
//
//   `blank()` replaces string literals with whitespace, so `const gate = '513873720', fixed = …` produces
//   `const gate =            , fixed = …` and `provenance('')` is `unknown` where `'513873720'` should be `internal`.
//
//   Measured before the fix: 22 declarations whose first value is a string literal, headed by
//   `growthbook-provider.cjs:170  const gate = '513873720', fixed = context.source.features` — the flag id this whole line of
//   work started from.
//
// THE FIX
//   The mask decides WHETHER a span is an assignment; the ORIGINAL decides WHAT the value is. Both strings have the same
//   length, so the offset carries over:
//
//       const rhsStart = m.index + m[0].indexOf(m[1]);
//       const rhs = text.slice(rhsStart, rhsStart + m[1].length);
//       … provenance: provenance(rhs)
//
//   The population is unchanged at 2 — none of the 22 had both provenances — so this is a classification repair, not a count
//   change. That is why it did not surface in R608's test: the tests assert on candidates, and a misclassified non-candidate is
//   invisible to them.
//
// THE BUG R608 DECLARED "KNOWN AND UNFIXED" IS A DIFFERENT ONE
//   R608 recorded that `mcp-session-auth.cjs:107` reports `row.config?.url, transport = row.config?.type` as url's value, because
//   the rhs capture runs past the comma. This round measured its blast radius and found it INERT:
//
//       multi-variable declarations with different provenances   89
//       of those, misreported by the concatenation                0
//
//   The reason is structural: a combined rhs always BEGINS with the first value, so any classifier that inspects the head sees
//   what it would have seen alone. The only way the tail could lead is an empty first value, and all six such cases are string
//   literals blanked to whitespace — which the fix above now reads correctly.
//
// WHAT IS NOT CLAIMED
//   Not that 89 is every multi-variable declaration: the pattern requires two `name = value` pairs on one statement with no
//   intervening comma-separated third. A four-variable declaration matches on its first two.
//   Not that the display text is now tidy: it still shows the trailing declaration, which is cosmetic and left alone.

/** The regression, its measurement, and the repair. */
const REGRESSION = {
  introducedBy: 'R608 — reading the value from blank(text) as well as matching over it',
  effect: "provenance('') === 'unknown' where a string literal must be 'internal'",
  measured: 22,
  example: "growthbook-provider.cjs:170  const gate = '513873720', fixed = context.source.features",
  repair: 'match over masked, read the value back from the original at the same offset',
  populationUnchanged: 2,
  whyUnnoticed: 'the tests assert on candidates, and a misclassified non-candidate never appears as one',
};

/** R608's declared-but-unfixed bug, and why it is inert. */
const PUNCTUATION_BUG = {
  site: 'tools/source-divergence.cjs — the rhs capture runs past the comma',
  visibleAt: 'mcp-session-auth.cjs:107',
  declarationsWithDifferentProvenance: 89,
  misreported: 0,
  why: 'a combined value always begins with the first value, so a head-inspecting classifier sees what it would have seen alone',
  tailCouldLeadOnlyIf: 'the first value is empty — all six such cases are string literals, now classified correctly',
};

module.exports = { REGRESSION, PUNCTUATION_BUG };
