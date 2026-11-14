'use strict';
// The cross-tool position index works — and shows that a POSITION is not a SUBJECT. Six of the 55 shared positions name more
// than one subject, and five of those are lines declaring several containers at once.
//
// WHAT WAS BUILT
//   All eight tools emit `file` plus a line-ish field (R614 measured that convention). So their rows can be joined on
//   (file, line). Measured:
//
//       distinct positions            643
//       cited by more than one tool    55
//       … naming ONE subject           49
//       … naming MORE than one          6
//
// THE SIX, AND WHAT EACH LINE ACTUALLY IS
//       growthbook-provider.cjs:45    seenFeatureExposure | seenExperimentExposure      2 `new Set(` on one line
//       mcp-relay-host.cjs:10         sessions, actors, connections, usedActors, usedConnections   5 containers, one line
//       hybrid-oidc-login.cjs:7       locks | active                                    Map + Set, one line
//       session-media-protocol.cjs:26 sessionKeys | active                               Map + Set, one line
//       session-video-protocol.cjs:25 tokens | epochs | active                           2 Maps + 1 Set, one line
//       main.cjs:376                  (denial and witness for ONE function)              one comment that both denies and observes
//
//   The first five are the comma-declaration shape R596 already knows about — the same shape that hid
//   `seenExperimentExposure` from four tools until the regex was widened. Here it does something different: it makes a position
//   ambiguous. Two tools can agree on `file:line` and be talking about different sets.
//
//   The sixth is not a declaration at all: `main.cjs:376` is a single comment line that carries both a denial and a measurement,
//   so `stale-comment` and `denial-vs-witness` both point at it for different reasons. That is one subject examined two ways, not
//   two subjects — a different kind of ambiguity from the other five.
//
// WHY THIS IS THE USEFUL OUTCOME RATHER THAN A NULL ONE
//   The join was worth building because it answers a question no single tool could: where does this work concentrate. The answer
//   is that 55 of 643 positions are seen by more than one tool, and that `growthbook-provider.cjs:45` is seen by FOUR — the flag
//   declaration line this entire line of work started from. The tools converged on it independently, from four different questions.
//
//   And the join immediately shows its own limit: it cannot be used as a SUBJECT index. Any cross-tool analysis that treats
//   `file:line` as identity will silently merge `seenFeatureExposure` with `seenExperimentExposure`, which is precisely the pair
//   whose difference R590 established.
//
// WHAT IS NOT CLAIMED
//   Not that a subject key exists to fix this: `name` is absent from half the tools (R610's差集), and where present it names a
//   set, a symbol, a function, or nothing. A true subject key would need each tool to say what it is ABOUT, which is a different
//   contract.
//   Not that 55 is a concentration finding: 49 of the 55 are the same tool pair (`set-lifetimes` + `set-reset-reach`), which share
//   a population by construction. The interesting number is the four-tool line, not the 55.

/** The join, measured. */
const JOIN = {
  positions: 643,
  citations: 755,
  shared: 55,
  oneSubject: 49,
  manySubjects: 6,
  note: '49 of the 55 are one tool pair sharing a population by construction; the signal is the four-tool line',
};

/** The six ambiguous positions, with what makes each ambiguous. */
const AMBIGUOUS = [
  {
    position: 'desktop/growthbook-provider.cjs:45',
    subjects: ['seenFeatureExposure', 'seenExperimentExposure'],
    containersOnLine: 2,
    tools: ['set-lifetimes', 'set-reset-reach', 'set-key-symmetry', 'clear-asymmetry'],
    kind: 'comma-declaration',
  },
  {
    position: 'desktop/mcp-relay-host.cjs:10',
    subjects: ['sessions', 'actors', 'connections', 'usedActors', 'usedConnections'],
    containersOnLine: 5,
    tools: ['set-lifetimes', 'set-reset-reach', 'map-key-reach'],
    kind: 'comma-declaration',
  },
  {
    position: 'desktop/hybrid-oidc-login.cjs:7',
    subjects: ['locks', 'active'],
    containersOnLine: 2,
    tools: ['set-key-symmetry', 'map-key-reach'],
    kind: 'comma-declaration',
  },
  {
    position: 'desktop/session-media-protocol.cjs:26',
    subjects: ['sessionKeys', 'active'],
    containersOnLine: 2,
    tools: ['set-key-symmetry', 'map-key-reach'],
    kind: 'comma-declaration',
  },
  {
    position: 'desktop/session-video-protocol.cjs:25',
    subjects: ['tokens', 'epochs', 'active'],
    containersOnLine: 3,
    tools: ['set-key-symmetry', 'map-key-reach'],
    kind: 'comma-declaration',
  },
  {
    position: 'desktop/main.cjs:376',
    subjects: ['relocateChromiumStorage'],
    containersOnLine: 0,
    tools: ['stale-comment', 'denial-vs-witness'],
    kind: 'one-comment-two-roles',
  },
];

/** The conclusion about identity. */
const CONCLUSION = {
  works: 'the join answers "where does this work concentrate" — 55 positions, and one seen by four tools',
  breaks: 'it cannot serve as a SUBJECT index: any analysis treating file:line as identity merges distinct sets',
  example: 'the merged pair at growthbook-provider.cjs:45 is exactly the pair whose difference R590 established',
  wouldNeed: 'each tool to declare what its row is ABOUT, which is a different contract than a position',
};

module.exports = { JOIN, AMBIGUOUS, CONCLUSION };
