// R629: it ran the 34 CLI tools that no test ever executes. 28 pass; all 6 "failures" are correct refusals, each wanting a
// precondition the harness did not supply. No new broken instrument.
//
// THE SELECTION
//   Of the tools a test names by path but never spawns, 34 are CLI-shaped (they read argv and have a main guard) — exactly the class
//   where R628's `text-assertion-audit` was hiding an EISDIR that fired on every run.
//
//   Ran all 34: 28 exited 0.
//
// THE SIX REFUSALS
//       setup-agent-core.cjs                 runs `bun install`; workspace links absent → bun ENOENT, then timeout
//       inspect-bootstrap-registry.cjs       wants a bundle path as argv[2]; with none it searches `undefined`
//       branch-mutation.cjs                  with --json it SUCCEEDED (`restored: true, total: 9`); the earlier SIGTERM was my timeout
//       proof-ccb-model-switch-r380.cjs      "a fresh output directory is required"
//       package-installer.cjs                "unknown argument: --json" — it takes no such flag
//       proof-hidden-history-import-confirm  "absolute evidence root required"
//
//   So the count of genuinely broken instruments stays at one (R628), and this sweep adds none.
//
// WHY THE CRITERION DID NOT PREDICT BREAKAGE
//   R628's defect fired on EVERY run — invisible only because nothing ran it. That is what happened. But 28 of these 34 are fine, so
//   "never executed" is a risk marker, not a defect class. The decisive difference is whether a code path fires only on REAL input:
//   `text-assertion-audit`'s directory guard fired on the typed input it always received.
//
// WHAT IS NOT CLAIMED
//   Not that 28 passing means 28 correct: they exited 0 with parseable output, and R628 showed a tool can exit 0 while doing the
//   wrong thing (its 19-versus-13 question is still open).
//   Not that these 34 are all CLI tools: the filter requires a test to name the tool by path, so a tool NO test mentions is outside
//   this sweep — and those are the least visible of all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SWEEP, REFUSALS, CRITERION } from '../desktop/never-executed-sweep.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the sweep arithmetic is consistent', () => {
  assert.equal(SWEEP.passed + SWEEP.refused, SWEEP.selected);
  assert.equal(REFUSALS.length, SWEEP.refused);
  assert.equal(SWEEP.genuinelyBroken, 0);
});

test('branch-mutation is recorded as having succeeded, not failed', () => {
  const bm = REFUSALS.find((r) => r.tool === 'branch-mutation.cjs');
  assert.ok(bm, 'branch-mutation is missing from the refusals');
  assert.match(bm.saw, /succeeded|restored true/, 'it is still described as a failure');
  assert.match(bm.wants, /nothing/, 'the entry still claims a missing precondition');
});

test('the tools that want a precondition name it', () => {
  const named = REFUSALS.filter((r) => /directory|bundle path|evidence root|arguments|workspace/.test(r.wants));
  assert.ok(named.length >= 5, `only ${named.length} refusals name a precondition`);
});

test('inspect-bootstrap-registry really takes a path argument', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'inspect-bootstrap-registry.cjs'), 'utf8');
  assert.match(src, /process\.argv\[2\]/, 'the tool no longer takes argv[2]');
  assert.match(src, /pass a shipped bundle path/, 'the error message changed');
});

test('package-installer really rejects --json', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'package-installer.cjs'), 'utf8');
  assert.match(src, /unknown argument/, 'the argument rejection is gone');
});

test('the criterion is recorded as a marker rather than a predictor', () => {
  assert.match(CRITERION.marker, /can break invisibly/, 'the marker is not stated');
  assert.match(CRITERION.predictor, /fires only on real input/, 'the predictor is not stated');
  assert.match(CRITERION.conclusion, /risk marker/, 'the conclusion is not drawn');
});

test('the record does not claim the 28 are correct', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'never-executed-sweep.cjs'), 'utf8');
  assert.match(src, /Not that 28 passing means 28 correct/, 'the limit is missing');
  assert.match(src, /19-versus-13 question is still open|19-versus-13/, 'the open question is not cited');
  assert.match(src, /least visible of all/, 'the unswept class is not disclosed');
});
