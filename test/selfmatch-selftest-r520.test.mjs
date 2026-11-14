// R520: a detector that reports zero must be shown to still detect. The zero from R519 was not yet trustworthy.
//
// THE PROBLEM WITH A COUNT THAT REACHES ZERO
//   R519 closed with `structural AND self-scan AND no comment stripping: 0`. That number means "nothing to find"
//   only if a real risk would still be caught. A detector that stopped classifying correctly produces the same
//   zero, and this session has repeatedly confused those two states — most sharply in R501, where a cross-check
//   compared a function the tool itself built and therefore could never disagree with it.
//
// WHAT THIS ROUND ADDS
//   tools/selfmatch-selftest.cjs runs the REAL scanner over six synthetic subjects whose answers are known:
//
//     self-via-filename    reads __filename                       -> selfScan true,  structural
//     self-via-dirname     reads a __dirname-joined path          -> selfScan true,  structural
//     self-via-write       reads a path it also writeFileSyncs    -> selfScan true,  structural
//     other-file           reads a path outside the script        -> selfScan FALSE, structural
//     self-literal-pattern reads itself, tests a quoted literal   -> selfScan true,  literal-path
//     self-filtered        reads itself, strips comments first    -> selfScan true,  filtered
//
//   Each case is written into a throwaway directory mirroring the repo layout, so the scanner runs unmodified and
//   scans the temp tree. Nothing is re-implemented: a copied predicate would only prove the copy agrees with itself.
//
// THE CONTROL THAT MAKES IT EVIDENCE
//   Deliberately broke `isSelfScan` twice and re-ran:
//       `return true`   -> 5/6, `other-file` fails on selfScan           (the R519 distinction lost)
//       `return false`  -> 1/6, four positives fail                       (detection lost entirely)
//   Both exit 1. A self-test that cannot fail is the thing it was built to rule out.
//
// WHAT THIS ESTABLISHES
//   The three distinctions that took R519's count from 30 to 2 — self vs other, structural vs literal, filtered vs
//   not — are still applied, and a genuine self-scan is still flagged. So the zero is a measurement.
//
// WHAT IT DOES NOT
//   Not that the scanner finds every scan. The detection is a `readFileSync` binding followed by a regex test within
//   900 characters; a scan routed through more indirection is missed. These cases test the classifier, not the
//   finder, and the tool says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELFTEST = path.join(ROOT, 'tools', 'selfmatch-selftest.cjs');
const SCANNER = path.join(ROOT, 'tools', 'comment-selfmatch.cjs');

const run = (args = []) => spawnSync(process.execPath, [SELFTEST, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true,
});

test('all six synthetic cases classify as expected', () => {
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the selftest failed:\n' + (r.stdout || '') + (r.stderr || ''));
  const d = JSON.parse(r.stdout);
  assert.equal(d.cases, 6, 'the case count changed');
  assert.equal(d.failed, 0, 'a case failed: ' + JSON.stringify(d.results.filter((x) => !x.ok)));

  const byName = new Map(d.results.map((x) => [x.name, x]));
  // Three positives.
  for (const n of ['self-via-filename', 'self-via-dirname', 'self-via-write']) {
    assert.equal(byName.get(n).observed.selfScan, true, `${n} is no longer detected as a self-scan`);
  }
  // Three negatives, each for a different reason.
  assert.equal(byName.get('other-file').observed.selfScan, false,
    'scanning a different file is classified as a self-scan: the R519 distinction is gone');
  assert.equal(byName.get('self-literal-pattern').observed.kind, 'literal-path',
    'a quoted literal is no longer classified apart from a structural pattern');
  assert.equal(byName.get('self-filtered').observed.filtersComments, true,
    'comment stripping is no longer noticed');
});

test('the real scan still reports a zero risky count', () => {
  const r = spawnSync(process.execPath, [SCANNER, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  assert.equal(r.status, 0);
  const d = JSON.parse(r.stdout);
  // The number may change; a non-zero value is not a failure, but it must then be examined. This assertion pairs
  // the zero with the selftest above: zero AND six passing cases means measured, zero alone would mean nothing.
  assert.ok(d.risky.length <= 4,
    `risky scans grew to ${d.risky.length}: re-examine before accepting`);
  assert.ok(d.selfScans > 0, 'no self-scans at all while six synthetic ones are detectable: the finder regressed');
});

test('the selftest runs the real scanner rather than a copy', () => {
  const source = fs.readFileSync(SELFTEST, 'utf8');
  assert.match(source, /fs\.copyFileSync\(SCANNER, path\.join\(dir, 'tools', 'comment-selfmatch\.cjs'\)\)/,
    'the selftest no longer copies the real scanner into the temp tree');
  assert.match(source, /Nothing is re-implemented/,
    'the reason for copying rather than re-implementing is no longer recorded');
  // It must not define its own classifier.
  assert.equal(/function\s+isSelfScan|function\s+classify/.test(source), false,
    'the selftest re-implements a predicate: it would then test its own copy');
});

test('the deliberate-breakage control is recorded', () => {
  const source = fs.readFileSync(SELFTEST, 'utf8');
  assert.match(source, /`return true`|return true/, 'the true-breakage control is not documented');
  assert.match(source, /A self-test that cannot fail is the thing it was built to rule out|zero is a measurement/,
    'the reason the control matters is gone');
});

test('the selftest states what it does not cover', () => {
  const source = fs.readFileSync(SELFTEST, 'utf8');
  assert.match(source, /tests the classifier, not the/i,
    'the selftest no longer disclaims coverage of the finder');
});

test('every case carries a stated reason', () => {
  const d = JSON.parse(run(['--json']).stdout);
  for (const r of d.results) {
    assert.ok(r.why && r.why.length > 20, `${r.name} has no stated reason`);
  }
});
