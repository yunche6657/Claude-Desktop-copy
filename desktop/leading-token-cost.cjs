'use strict';
// The cost R557 recorded against the leading-token filter is REAL but EMPTY in this repository.
//
// WHAT R557 SAID
//   Narrowing `list-skeleton-divergence` from 31 groups to 4 was deliberate, and the record named the price:
//
//       "a real divergence that ALSO changes the leading token is now hidden, and no amount of local text can tell
//       'one job done differently' from 'two jobs' in general"
//
//   That is a claim about the filter, and it has two halves that need separating:
//
//       the filter DOES hide such groups        — a property of the rule
//       any such group EXISTS here              — a property of this repository
//
//   R557 asserted the first and left the second open. This round measures both.
//
// MEASURED
//       groups the skeleton detector can see (`--min 1`)     19
//       ... whose variants all share a leading token          19
//       ... whose leading tokens DIFFER                        0
//
//   So nothing is currently hidden by that clause. The rule is capable of hiding — verified on synthetic skeletons:
//
//       'if (a) return 1;' vs 'return x;'        if    vs x       HIDDEN
//       'for (;;) {}'      vs 'while (true) {}'  for   vs while   HIDDEN
//       'const a = 1;'     vs 'let a = 1;'       a     vs a       KEPT   (the regex captures the DECLARED NAME)
//
//   The third row is worth noticing for a different reason: the pattern's optional keyword group means `const a` and
//   `let a` produce the same token `a`. Two variants differing only in declaration kind are treated as the same job. That
//   is a second, unrecorded leniency — it errs toward KEEPING groups, so it cannot hide anything, but it means the "leading
//   token" is often a name rather than a keyword, which is not what the comment describes.
//
// WHAT THIS CLOSES, AND WHAT IT DOES NOT
//   Closes: R557's stated cost has no instance in this tree, so a reader should not expect a hidden group to exist.
//   Does not close: the rule still cannot distinguish "one job done differently" from "two jobs" in general. The zero is a
//   fact about today's code, not a proof that the clause is safe. If a group ever appears with `if` in one variant and
//   `for` in another, it will be silently dropped — and nothing will say so.
//
// THE ASYMMETRY THAT MAKES THE ZERO CHEAP TO TRUST
//   This filter errs toward HIDING, so a zero is weaker evidence than a non-zero would be: it says there is nothing to
//   hide today, not that the filter would show it if there were. That is why the synthetic cases are part of the record —
//   they establish the rule still bites, so the zero is not the result of a dead clause.
//
//   The zero is DATED, NOT PERMANENT: it records what this tree contained on the round that measured it. A drift with no
//   repeated list is invisible to both this filter and `duplicated-lists`, as R580 established for a different detector.

/** The clause, as it behaves, measured on synthetic skeletons. */
const SYNTHETIC = [
  { a: 'if (a) return 1;', b: 'return x;', tokenA: 'if', tokenB: 'x', verdict: 'HIDDEN' },
  { a: 'for (;;) {}', b: 'while (true) {}', tokenA: 'for', tokenB: 'while', verdict: 'HIDDEN' },
  { a: 'const a = 1;', b: 'let a = 1;', tokenA: 'a', tokenB: 'a', verdict: 'KEPT' },
  { a: 'await f();', b: 'f();', tokenA: 'f', tokenB: 'f', verdict: 'KEPT' },
];

/** What the tree contains, measured with `--min 1`. */
const CENSUS = {
  groupsVisible: 19,
  uniformLeadingToken: 19,
  mixedLeadingToken: 0,
  note: 'the zero is a fact about this tree, not a proof the clause is safe; the clause errors toward hiding, so a zero is '
    + 'weaker evidence than a non-zero would be',
};

/** The unrecorded leniency the synthetic measurement exposed. */
const SECOND_LENIENCY = {
  what: 'const a / let a / var a all yield the token `a`, because the keyword group is optional and the name group captures',
  effect: 'variants differing only in declaration kind count as the same job',
  direction: 'errors toward KEEPING groups, so it cannot hide anything — but it means "leading token" is often a name, '
    + 'not a keyword, which is not what the comment claims',
};

module.exports = { SYNTHETIC, CENSUS, SECOND_LENIENCY };
