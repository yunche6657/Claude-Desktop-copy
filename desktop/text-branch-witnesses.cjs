'use strict';
// The three branches R570 listed, checked by hand: all LIVE, and the reason each one matters.
//
// WHY THIS IS A LIST AND NOT A DETECTOR
//   R571 tried to answer "is this branch still live?" generically, and the detector was wrong three times in a row on the
//   same file:
//
//     1. counting OTHER lines        `const denied = gate(row,false); if (denied) return denied;` — the definition shares
//                                    the branch's line, so `denied` looked used nowhere
//     2. counting this line, uses>1  `denied` occurs THREE times on that one line and on no other, so its line count is 1
//     3. requiring a `const/let/var` producer
//                                    `catch (error) { … if (error instanceof AgentError) … }` — `error` is bound by the
//                                    catch clause, so the branch at `agent.cjs:146` became "lonely", and 356 of 3346
//                                    branches were flagged, including every `err.code === 'EADDRINUSE'` guard
//
//   Each fix narrowed the rule and the next shape defeated it. The fourth fix would be "also count catch parameters, and
//   function parameters, and destructuring, and reduce callbacks" — which is a parser, not a rule. So the generic question
//   is abandoned and the three cases are recorded with what makes each live. A conclusion that survives reading is worth
//   more than a detector that keeps being wrong.
//
// THE THREE, AND WHAT PROVES EACH IS LIVE
//   The proof is not "the name appears twice". It is that REMOVING the branch changes an outcome, and that outcome is
//   recorded in the code's own comment.

/** Branches that a test pins as text, which R571 read and confirmed live. */
const VERIFIED_LIVE = [
  {
    file: 'desktop/bridge-services.cjs',
    line: 233,
    branch: "if (/searchSessions$/i.test(frag)) return [];",
    live: 'ORDER — line 243 is `if (/Sessions$/i.test(frag) || …) return { sessions: [], archived: [], pinned: [] }`, '
      + 'which also matches `searchSessions`. Without this line the palette consumer `for (let t of l)` receives an object '
      + 'and throws "l is not iterable". The comment above records that happening, including the error boundary the whole '
      + 'route fell into.',
    witness: 'comment records the observed TypeError',
  },
  {
    file: 'desktop/bridge-services.cjs',
    line: 242,
    branch: "if (/listCliSessions$/i.test(frag)) return [];",
    live: 'ORDER, same reason — `listCliSessions` also ends in "Sessions". Its consumer passes the answer to '
      + '`select: e => e.map(jo)`, so the container shape made it throw "a.map is not a function" and the CLI session list '
      + 'stayed empty with no visible error.',
    witness: 'comment names the bundle that consumes it',
  },
  {
    file: 'desktop/agent.cjs',
    line: 146,
    branch: 'if (error instanceof AgentError) throw error;',
    live: 'MEASURED. `messagesEndpoint(baseUrl)` sits inside the same try, so a missing base URL threw '
      + "'invalid-base-url' and was rewritten to 'network'. The comment records the observed result: "
      + "{ code: 'network', message: 'request failed: a base URL is required' } — the right sentence under the wrong code.",
    witness: 'the comment contains the word MEASURED and the observed object',
  },
];

/**
 * The property all three share, stated so it can be checked rather than assumed: each branch sits BEFORE another branch
 * that would otherwise claim the same input, or it distinguishes an error class from the generic fallback.
 */
const SHARED_PROPERTY = 'each branch prevents a LATER branch from claiming the same input';

module.exports = { VERIFIED_LIVE, SHARED_PROPERTY };
