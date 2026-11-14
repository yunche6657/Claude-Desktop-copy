'use strict';
// One of the 65 JSON instruments was BROKEN and nothing noticed: `text-assertion-audit.cjs` threw EISDIR and exited 1 for every
// invocation, because `resolveSubject()` can return a directory and `existsSync` is true for directories.
//
// HOW IT WAS FOUND
//   R626 concluded that the instruments are better than the ad-hoc probes substituted for them. R628 tested that claim by running
//   every tool that advertises `--json`:
//
//       65 advertise JSON      59 emit JSON and exit 0      6 "failed"
//
//   Reading all six: four were my own truncation (`Select-Object -First 26` closes the pipe), one needs a live Electron
//   (`cdp-approval-probe` — ECONNREFUSED on 9340 is correct behaviour), and ONE was real:
//
//       tools/text-assertion-audit.cjs:181   EISDIR: illegal operation on a directory, read
//
// THE DEFECT, EXACTLY
//   `resolveSubject()` builds a path from the quoted segments of a `path.join(ROOT, ...)` expression. When a test resolves
//   `path.join(ROOT, 'desktop')` the result is a DIRECTORY. The guard was:
//
//       if (subjectPath && fs.existsSync(subjectPath)) { ... readFileSync(subjectPath, 'utf8') ... }
//
//   `existsSync` answers "does this path exist", not "is this a file", so a directory passed the guard and `readFileSync` threw.
//   The throw escaped: the whole scan died before printing anything.
//
// THE FIX, AND WHY IT IS THE RIGHT SHAPE
//   `fs.statSync(p).isFile()` in a try/catch, so an unresolvable or unreadable subject leaves `subjectChecked: false` and the row
//   keeps its pattern-only verdict — which the tool already models. A subject that cannot be read is a row the tool cannot measure,
//   not a reason to abort 331 other assertions.
//
// WHY IT SURVIVED
//   Its own test (`text-assertion-audit` assertions live in `evidence/text-assertion-data-r582.md` and a test that reads the tool's
//   SOURCE) never RAN it. That is the same failure R621 found with `provenance` — a field computed and never checked — one layer up:
//   a tool executed and never checked.
//
// WHAT IS NOT CLAIMED
//   Not that the other 58 are silently correct: this round established only that they exit 0 with parseable JSON.
//   Not that the tool's verdicts changed: `filesScanned 817`, `sourceAssertions 331`, `controlFlow 19`, `wiring 312` — the same
//   population it always would have produced, now that it can run.

/** The sweep, with each of the six failures explained. */
const SWEEP = {
  advertisingJson: 65,
  working: 59,
  failed: 6,
  realDefects: 1,
  explanations: [
    { tool: 'branch-mutation.cjs', cause: 'my own pipe truncation, not a failure' },
    { tool: 'indirect-tested-hotspots.cjs', cause: 'my own pipe truncation' },
    { tool: 'script-runnability.cjs', cause: 'my own pipe truncation' },
    { tool: 'update-changelog.cjs', cause: 'emitted valid JSON; my check only looked for a leading brace after truncation' },
    { tool: 'cdp-approval-probe.cjs', cause: 'needs a live Electron on 127.0.0.1:9340 — ECONNREFUSED is correct' },
    { tool: 'text-assertion-audit.cjs', cause: 'REAL: EISDIR from reading a directory' },
  ],
};

/** The defect and its repair. */
const DEFECT = {
  tool: 'tools/text-assertion-audit.cjs',
  site: 'line 181, inside the per-assertion loop',
  error: 'EISDIR: illegal operation on a directory, read',
  cause: 'resolveSubject() can return a directory (path.join(ROOT, \'desktop\')) and existsSync is true for a directory',
  guardWas: 'if (subjectPath && fs.existsSync(subjectPath))',
  repair: 'fs.statSync(p).isFile() in a try/catch; an unreadable subject leaves subjectChecked false',
  after: { filesScanned: 817, sourceAssertions: 331, controlFlow: 19, wiring: 312 },
};

/** Why nothing noticed. */
const SURVIVED_BECAUSE = {
  testShape: 'the test asserts on the tool SOURCE, never executes it',
  sameClassAs: 'R621\'s `provenance` — computed and never checked — one layer up: a tool executed and never checked',
};

module.exports = { SWEEP, DEFECT, SURVIVED_BECAUSE };
