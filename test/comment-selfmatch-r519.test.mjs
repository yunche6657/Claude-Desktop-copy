// R519: a scanner for the failure family that produced three wrong readings — and its first version was wrong in
// the same way it was built to detect.
//
// THE FAMILY
//   Three rounds reported something they read out of their own documentation:
//     R493  a detector searched a file for `new RegExp` and matched the comment explaining `new RegExp`;
//     R505  a bundle scan for "MCPTool" counted the comment naming the file it lives in;
//     R518  a test asserted a non-greedy pattern was gone, regexed the whole tool file, and matched the comment
//           quoting the old line to explain what had been wrong.
//
// THE SCANNER, AND WHY ITS FIRST VERSION WAS WORSE THAN USELESS
//   Version 1 flagged 30 "structural" whole-file scans. Spot-checking one disproved the premise:
//       tools/ccb-contract-diff.cjs  reads `.tmp/ccb-src/...` — a DIFFERENT file — and searches it for
//       `const commonFields = lazySchema(...)`
//   That target's comments were never going to match, because the pattern hunts real code in a source tree.
//
//   The defect needs the searched file to BE the searching file. Adding that distinction cut the flagged set from
//   30 to 2. Had the 30 been published as findings, that would have been a fourth instance of the same family:
//   a report about prose that was never examined.
//
// WHAT SURVIVES, AND IT IS REAL
//       test/tool-relation-r494.test.mjs
//           L36  comment:   "`interfaceBody` used `new RegExp(`... \r?\n`)`. A template literal turns ..."
//           assertion:      assert.ok(!/new RegExp\(/.test(body), 'interfaceBody uses new RegExp again: ...')
//   Safe only because `body` is a SLICE between two function names and line 36 falls outside it. Move the boundary
//   and the test fails against its own explanation. R519 fixed it by stripping comment lines from the slice.
//
// WHAT THIS ESTABLISHES
//   A reproducible inventory of the risky intersection (structural pattern × self-scan × no comment stripping),
//   rather than a fourth verbal reminder. Two rows, both examined, one repaired.
//
// WHAT IT DOES NOT
//   Not a proof of absence. The detection is heuristic (a readFileSync binding, then a regex test on it within 900
//   characters); a scan that spans more indirection is missed and is reported as a coverage gap, not a pass.
//   `literal-path` and `class-based` rows are reported but not judged — some of them may matter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'comment-selfmatch.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('the scanner distinguishes self-scans from scans of other files', () => {
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the scanner failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);

  assert.ok(d.total > 50, `suspiciously few scans found: ${d.total}`);
  assert.ok(d.selfScans > 0, 'no self-scans detected at all: the classifier may be broken');
  assert.ok(d.selfScans < d.total,
    'every scan classified as a self-scan: the classifier is not discriminating');

  // The specific non-self case that disproved version 1 must NOT be risky.
  const ccbDiff = d.risky.filter((x) => x.file.includes('ccb-contract-diff'));
  assert.equal(ccbDiff.length, 0,
    'a scan of a different source tree is still flagged as risky: the version-1 error is back');
});

test('the risky intersection is small and stays small', () => {
  const d = JSON.parse(run(['--json']).stdout);
  // The number is allowed to change; an unexplained jump is what should fail.
  assert.ok(d.risky.length <= 4,
    `risky scans grew to ${d.risky.length}: re-examine before accepting`);
  for (const r of d.risky) {
    assert.equal(r.kind, 'structural', 'a non-structural row appeared in the risky set');
    assert.equal(r.selfScan, true, 'a non-self-scan appeared in the risky set');
    assert.equal(r.filtersComments, false, 'a comment-filtering file appeared in the risky set');
  }
});

test('the two live findings are recorded, including the one that was repaired', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /test\/tool-relation-r494\.test\.mjs/,
    'the scanner no longer names the file it found');
  assert.match(source, /surviving by one accident|safe TODAY only because/i,
    'the scanner no longer explains why the finding was latent rather than active');

  // The cross-reference lives in the test file that was found, not in the scanner.
  const found = fs.readFileSync(path.join(ROOT, 'test', 'tool-relation-r494.test.mjs'), 'utf8');
  assert.match(found, /comment-selfmatch\.cjs flags it as one of two live self-scan risks/,
    'the repaired test no longer cross-references the scanner that found it');
});

test('the repaired assertion no longer depends on a slice boundary', () => {
  const testFile = fs.readFileSync(path.join(ROOT, 'test', 'tool-relation-r494.test.mjs'), 'utf8');
  // It must strip comments before asserting, not rely on the slice happening to exclude them.
  assert.match(testFile, /filter\(\(l\) => !l\.trim\(\)\.startsWith\('\/\/'\)/,
    'the assertion does not strip comment lines');
  assert.match(testFile, /accident of the slice boundary/,
    'the test no longer records why it was vulnerable');
});

test('the tool states its own coverage limit', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /Heuristically, and stated as such/,
    'the heuristic nature is no longer disclosed');
  assert.match(source, /is a coverage gap, not a pass/,
    'the tool no longer warns that a missed scan is not a clean bill');
  assert.match(source, /hypothesis test|Triage, not proof/,
    'the triage disclaimer is gone');
});

test('the first version being wrong is documented, not erased', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /cut the flagged set from 30 to 2|from 30 to 2/,
    'the correction from 30 to 2 is no longer recorded');
  assert.match(source, /a report about prose that was never examined/,
    'the reason the 30 would have been a fourth instance is gone');
});
