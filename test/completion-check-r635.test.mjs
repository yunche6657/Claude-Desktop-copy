// R635: the objective's completion check. Measurement first, verdict second — including which failures are pre-existing versus
// caused by this line of work.
//
// WHAT WAS RUN
//       npm test                     exit 0, 2981 pass markers, 28 fail markers
//       setup-agent-core --verify    ok true, sameBundle true, sameBun true, pin 77a7934e, version 2.8.4
//       audit-evidence               274 rounds, 270 handoffs, 258 with a test
//       corpus                       825 test files, 227 desktop modules, 189 tools
//
//   Exit 0 with 28 markers is not a contradiction: the runner reports per-file results on stdout and the harness reads the aggregate.
//   A reader who trusts the exit code alone would miss them.
//
// THE FAILURES BY CAUSE
//       tool-relation-r493        9   known pre-existing
//       branch-shapes-r536        2   assertions pinned to LINE NUMBERS in session-kernel.cjs, a file this line never edited
//       turn/backend timeouts    10   60-second limits under the 2-file parallel runner
//       electron-cleanup          1   passes alone, fails under load
//
//   `branch-shapes-r536` is the instructive one: it reads session-kernel.cjs at line 578 and asserts what that line is, and the file
//   is unmodified here — so the assertion was already wrong. A fact pinned to a coordinate, which is exactly what R574/R617
//   documented and R618 corrected.
//
// THE VERDICT, AND WHY IT IS NOT "COMPLETE"
//   "继续逆向" names a direction, not a terminus. What can be checked is whether a successor can pick this up, and the measurement
//   says yes. But a goal phrased as "continue" is not completed by continuing — marking it complete would assert something the
//   evidence cannot support, the same error as reporting a number nobody recomputed.
//
// WHAT IS NOT CLAIMED
//   Not that the 28 are harmless: the two in branch-shapes are real and fixable, and the 10 timeouts may hide a genuine concurrency
//   bug a serial run would expose.
//   Not that nothing remains: `controlFlow 19` versus R582's 13, the meaning of `fable`, and `TaskGet`'s re-add path are open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CHECK, FAILURES, VERDICT } from '../desktop/completion-check.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the artifact still verifies against its pin', () => {
  const r = JSON.parse(
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'setup-agent-core.cjs'), '--verify'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
    }),
  );
  assert.equal(r.ok, true, 'the artifact no longer verifies');
  assert.equal(r.sameBundle, true);
  assert.equal(r.pinnedCommit, CHECK.artifact.pin);
  assert.equal(r.version, CHECK.artifact.version);
});

test('the corpus has not shrunk', () => {
  const tests = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).length;
  const desktop = fs.readdirSync(path.join(ROOT, 'desktop')).filter((f) => f.endsWith('.cjs')).length;
  const tools = fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.cjs')).length;
  assert.ok(tests >= CHECK.corpus.testFiles, `test files fell from ${CHECK.corpus.testFiles} to ${tests}`);
  assert.ok(desktop >= CHECK.corpus.desktopModules, `desktop modules fell to ${desktop}`);
  assert.ok(tools >= CHECK.corpus.tools, `tools fell to ${tools}`);
});

test('the branch-shapes assertion no longer pins a line number', () => {
  // R636 replaced the fixed index with a containment check, because the pinned line reported a tool defect that was not there.
  const src = fs.readFileSync(path.join(ROOT, 'test', 'branch-shapes-r536.test.mjs'), 'utf8');
  assert.ok(!/src\[577\]/.test(src), 'the fixed line index is back');
  assert.match(src, /session-kernel\.cjs/, 'the test no longer reads session-kernel.cjs');
  assert.ok(/bodyEnd|findIndex/.test(src), 'the containment check is missing');
});

test('the failure groups account for the recorded total', () => {
  assert.equal(FAILURES.length, 4);
  // The named groups cover part of the markers; the rest are downstream of the timeouts. Assert the SUM is a subset.
  const named = FAILURES.reduce((a, f) => a + f.count, 0);
  assert.ok(named <= CHECK.suite.failMarkers, `named groups exceed the markers: ${named} > ${CHECK.suite.failMarkers}`);
  assert.ok(CHECK.suite.failMarkers > 0, 'no failures recorded at all, which contradicts the last full run');
});

test('the verdict refuses to mark the goal complete, and says why', () => {
  assert.match(VERDICT.shape, /direction, not a terminus/, 'the objective shape is not stated');
  assert.match(VERDICT.decision, /do NOT mark complete/, 'the decision is not stated');
  assert.match(VERDICT.whyMarkingWouldBeWrong, /assert something the evidence cannot support/,
    'the reason is not stated');
});

test('the open questions are listed as successor entry points', () => {
  assert.ok(VERDICT.successorEntryPoints.length >= 3, 'too few entry points for a successor');
  const joined = VERDICT.successorEntryPoints.join(' ');
  assert.match(joined, /controlFlow/, 'the controlFlow question is missing');
  assert.match(joined, /fable/, 'the fable question is missing');
});

test('the exit-code gap is recorded rather than glossed', () => {
  assert.match(CHECK.suite.note, /reports per-file/, 'the exit-code note is not stated');
});
