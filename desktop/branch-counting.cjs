'use strict';
// `branch-coverage.cjs` already handles both traps this line of work kept falling into: it excludes `else if` from its `if`
// count with a lookbehind, and it excludes `.catch(` method calls from its catch count by requiring statement position.
//
// THE GROUND TRUTH, AND THE TOOL'S ANSWER
//   Measured on `desktop/session-kernel.cjs` with strings and comments blanked:
//
//       if( total (includes else if)   322
//       plain if only                  315
//       else if                          7
//       catch in any form               32
//       catch in statement position     24
//
//   The tool reports:
//
//       branches 352 = if 315 + else-if 7 + else 6 + catch 24
//
//   Every component matches a measurement, and the sum closes. Nothing in the tool is double-counted.
//
// HOW IT AVOIDS BOTH TRAPS
//       tools/branch-coverage.cjs:261   /(?<!else\s)\bif\s*\(/g      the lookbehind excludes `else if`
//       its catch rule                  statement position only      so `promise.catch(` is not a branch
//
//   Both are the exact distinctions R625 had to rediscover by hand. The tool had them already.
//
// WHAT THIS SAYS ABOUT THE FOUR-ROUND PATTERN
//   R621, R622, R624 and R625 all reported a mismatch that turned out to be my reading. Here the direction is reversed and it is
//   instructive: the two tools were RIGHT and my hand-count was wrong in two separate ways at once — I counted `else if` twice and
//   I counted `.catch(` as a branch. A careful tool and a careless reader, disagreeing, with the tool correct.
//
//   So the pattern is not "the instruments are wrong". It is "the instruments are better than the ad-hoc probes I substitute for
//   them when I am in a hurry". R625's hand count took two attempts and still got catch wrong; the tool had it right the whole time.
//
// WHAT IS NOT CLAIMED
//   Not that every tool in `tools/` is this careful: this looks at two, and one of them (`empty-block-scan.cjs`) answers a different
//   question (empty bodies, not branch counts).
//   Not that 352 is comparable to the 367 in the STATUS.md claim: 367 counts `else if` twice and calls `catch` 32, so the two numbers
//   measure different things. The claim is a historical note about one counting convention; the tool measures branches.

/** The two conventions, measured side by side. */
const COUNTING = {
  file: 'desktop/session-kernel.cjs',
  plainIf: 315,
  elseIf: 7,
  ifTotal: 322,
  else: 6,
  catchAnyForm: 32,
  catchStatementPosition: 24,
  toolBranches: 352,
  toolBreakdown: { if: 315, elseIf: 7, else: 6, catch: 24 },
  closes: 315 + 7 + 6 + 24 === 352,
};

/** The two traps the tool already handles. */
const TRAPS = [
  {
    trap: '`else if` counted twice',
    how: 'a negative lookbehind on the if pattern',
    site: 'tools/branch-coverage.cjs:261',
    handCountError: 'my 322 read as a plain-if count gives 360, which does not close',
  },
  {
    trap: '`.catch(` counted as a branch',
    how: 'requiring statement position, so a method call is not a branch',
    handCountError: 'my 32 versus the tool\'s 24 — the 8 difference is promise method calls',
  },
];

/** The reversed lesson. */
const LESSON = {
  pattern: 'the instruments are better than the ad-hoc probes I substitute for them when in a hurry',
  evidence: 'R625\'s hand count took two attempts and still got catch wrong; the tool had it right the whole time',
  contrast: 'R621/R622/R624/R625 each reported a mismatch that was my reading — here my reading was wrong and the tool was right',
};

module.exports = { COUNTING, TRAPS, LESSON };
