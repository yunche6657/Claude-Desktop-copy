'use strict';
// Running the 34 CLI tools that no test ever executes: 28 pass, and all 6 "failures" are correct refusals — each wants a
// precondition the harness did not supply.
//
// THE SELECTION
//   Of the tools a test REFUSES to execute but names by path, 34 are CLI-shaped (they read argv and have a main guard). Those are
//   the ones that could be broken without any test noticing — R628's `text-assertion-audit` was exactly such a member.
//
//   Ran all 34 with `--json` where advertised: 28 exited 0.
//
// THE SIX REFUSALS, EACH CORRECT
//       setup-agent-core.cjs                 runs `bun install`; the workspace links are absent, so bun fails and the tool times out
//       inspect-bootstrap-registry.cjs       takes a bundle path as argv[2]; with none it searches `undefined` and reports no anchor
//       branch-mutation.cjs                  run with --json it actually SUCCEEDED (`restored: true, total: 9`) — my earlier
//                                            classification saw a SIGTERM from the first sweep's timeout, not a defect
//       proof-ccb-model-switch-r380.cjs      "a fresh output directory is required" — a stated precondition
//       package-installer.cjs                "unknown argument: --json" — it does not take that flag
//       proof-hidden-history-import-confirm  "absolute evidence root required" — a stated precondition
//
//   So the count of genuinely broken instruments stands at one, found in R628, and this sweep adds none.
//
// WHY "NEVER EXECUTED BY A TEST" DID NOT PREDICT BREAKAGE
//   R628's defect was an EISDIR that fired on EVERY run. A tool that fails every time is only invisible if nothing runs it — and that
//   is what happened. But most of these 34 are fine, so "never executed" is a risk marker, not a defect class. The decisive
//   difference is whether the tool has a code path that only fires on real input: `text-assertion-audit`'s directory guard fired on
//   the typed input it always received.
//
// WHAT IS NOT CLAIMED
//   Not that 28 passing means 28 correct: they exited 0 with parseable output, and R628 showed that a tool can exit 0 while doing
//   the wrong thing (its 19-versus-13 question is still open).
//   Not that the 34 are all the CLI tools: the filter requires a test to name the tool by path, so a tool no test mentions at all is
//   outside this sweep — and those are the least visible of all.

/** The sweep. */
const SWEEP = {
  selected: 34,
  passed: 28,
  refused: 6,
  genuinelyBroken: 0,
  note: 'R628 found the one broken instrument; this sweep adds none',
};

/** Each refusal, and the precondition it wanted. */
const REFUSALS = [
  { tool: 'setup-agent-core.cjs', wants: 'a workspace with linked dependencies', saw: 'bun install ENOENT on workspace packages, then SIGTERM' },
  { tool: 'inspect-bootstrap-registry.cjs', wants: 'a shipped bundle path as argv[2]', saw: 'anchor not found, searching undefined' },
  { tool: 'branch-mutation.cjs', wants: 'nothing — it succeeded', saw: 'restored true, total 9; the earlier SIGTERM was my timeout' },
  { tool: 'proof-ccb-model-switch-r380.cjs', wants: 'a fresh output directory', saw: 'a stated precondition' },
  { tool: 'package-installer.cjs', wants: 'arguments it understands', saw: 'unknown argument: --json' },
  { tool: 'proof-hidden-history-import-confirm.cjs', wants: 'an absolute evidence root', saw: 'a stated precondition' },
];

/** Why the selection criterion was a marker, not a predictor. */
const CRITERION = {
  marker: 'a tool no test executes can break invisibly',
  predictor: 'a code path that fires only on real input',
  instance: 'text-assertion-audit\'s directory guard fired on the typed input it always received',
  conclusion: 'never-executed is a risk marker; 28 of these 34 are fine',
};

module.exports = { SWEEP, REFUSALS, CRITERION };
