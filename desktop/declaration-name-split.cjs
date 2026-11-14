'use strict';
// The declaration name is NOT normalised, so the skeleton detector splits where it should merge. Capable of it, empty here.
//
// THE HYPOTHESIS, AND ITS DIRECTION
//   R583's synthetic cases showed `const a` and `let a` yield the same leading token `a`, because the keyword group is
//   optional and the NAME group captures. That suggested a follow-up: if the declaration name is not normalised away, then a
//   rule written twice with different variable names cannot be recognised as one rule.
//
//   Measured directly, stripping only what `skeletonAt` strips (member values -> `<LIST>`, quotes unified, whitespace
//   removed):
//
//       const alpha = ['A','B'];   ->   constalpha=[<LIST>];   leadingToken: alpha
//       const beta  = ['A','B'];   ->   constbeta=[<LIST>];    leadingToken: beta
//
//   The skeletons are unequal and the tokens differ, so two copies of one rule are TWO GROUPS. That is the SPLIT direction:
//   R557's recorded cost was about the filter MERGING unrelated groups (hiding a divergence); this is the opposite failure,
//   separating related ones.
//
// MEASURED IN THIS TREE
//       variants the skeleton detector reports (`--min 1`)     43
//       ... whose skeleton begins `const NAME =`                4
//       groups that would MERGE if the name were blanked        0 new pairs
//
//   The four are two pairs — `base`/`base` and `g`/`g` — where the name already matches. So nothing is currently split by
//   this: the rule can split, and has no instance to split.
//
// WHY THIS IS WORTH RECORDING WHEN THE COUNT IS ZERO
//   Same reason as R583: the two failures sit on opposite sides of one filter, and a reader who knows only about the hiding
//   direction would assume unrelated groups merge and related ones survive. Both directions are live in the rule and only one
//   has instances. Recording the empty one stops the next round from "discovering" it and treating it as new.
//
//   It also names the fix, if a case ever appears: blank the declaration name after `const`/`let`/`var` before comparing,
//   the same way loop variables were normalised in R557.
//
// WHY THAT FIX WOULD NOT BE SAFE TODAY
//   The two `base` variants prove it. They are already one group, and their skeletons differ AFTER `const base =`:
//
//       constbase=schemaFields('baseInputSchema');…
//       constbase=schemaBody(text,'baseInputSchema');assert.deepEqual(…
//
//   Same name, same list, different INPUT. That is the interesting divergence, not a duplication — and blanking the name
//   would leave the verdict unchanged while changing what the comparison is about. So the fix is only correct for cases
//   where the divergence is purely the name; the detector has no way to tell which is which.
//
// WHAT IS NOT CLAIMED
//   Not that blanking would be safe in general: it would also merge two rows that are one job with two different inputs,
//   which is what a reader most wants to see.
//   Not that 4 of 43 is the real rate: `--min 1` sees only lists that repeat, so a declaration whose middle is not a repeated
//   list is invisible to this detector entirely. The split could be commoner in code this tool cannot see.
//   Not that normalising is right: it would be the third edit to this filter, and R571 withdrew a rule after three.

/** The normalisation `skeletonAt` performs, reproduced so the split can be demonstrated without touching the tree. */
const NORMALISATION = {
  memberValues: "replaced with '<v>' then collapsed to '<LIST>'",
  quotes: 'double quotes unified to single',
  whitespace: 'all removed',
  declarationName: 'NOT normalised',
  loopVariable: 'normalised since R557',
};

/** The measured pair, and what each side becomes. */
const SPLIT_EXAMPLE = {
  a: { source: "const alpha = ['A','B'];", skeleton: 'constalpha=[<LIST>];', token: 'alpha' },
  b: { source: "const beta = ['A','B'];", skeleton: 'constbeta=[<LIST>];', token: 'beta' },
  verdict: 'TWO GROUPS — the skeletons differ and the leading tokens differ',
};

/** This tree, measured with `--min 1`. */
const CENSUS = {
  variantsReported: 43,
  startingWithDeclarationName: 4,
  newMergesIfBlanked: 0,
  note: 'the four are two pairs where the name already matches, so nothing is split today; the rule can split and has no '
    + 'instance to split',
};

module.exports = { NORMALISATION, SPLIT_EXAMPLE, CENSUS };
