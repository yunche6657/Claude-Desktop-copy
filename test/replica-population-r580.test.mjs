// R580: the list detector answers a NARROWER question than its output implies — it can see 22% of replica-shaped files.
//
// THE MEASUREMENT
//   `group-provenance` classifies whether a repeated LIST is a replica-versus-original pair. R562's actual discovery — a
//   test that reads the official bundle and runs a slice of it in a VM — is a property of a TEST FILE, no list involved.
//   Counting the file property directly:
//
//       reads official material AND executes a slice      54
//       ... appearing in at least one repeated list       12
//       ... in no list group at all                       42      78%
//
//   `cli-mcp-host-sources-r378.test.mjs` is one of the 42: three chunks read from `../ccd-ref/asar/.vite/build`, slices of
//   all three executed, and no repeated list — so the detector never visits it.
//
// WHAT IS NOT WRONG
//   `group-provenance` itself. Its question is answerable and its answers held when read: R563 verified four groups, R578
//   added a fifth by widening the read rule. What is wrong is reading its output as "these are the replica-shaped tests".
//
// WHY IT MATTERS
//   The replica-versus-original distinction exists to stop this project from "unifying" constants that exist to be
//   compared. A rule that sees a fifth of them gives a false sense of coverage — and a reader of the R563 evidence would
//   reasonably conclude the population had been enumerated.
//
// THE PATTERN ACROSS FOUR ROUNDS, NOW NAMED
//       R574  keyed by FIELD NAME            mechanism right, subject too coarse
//       R575  re-keyed by RECEIVER           subject right for that tool, one row still wrong
//       R578  two facts in ONE EXPRESSION    subject right, container wrong
//       R580  analysis attached to the LIST  subject wrong entirely
//
//   Each time the mechanism survived and the SUBJECT did not. R576's ledger records a key per detector and has no column
//   for "what is this key a property of" — which is the column this round needed. It is recorded here rather than
//   retrofitted, because retrofitting a ledger to justify a conclusion is how ledgers stop being evidence.
//
// WHAT IS NOT CLAIMED
//   Not that 54 is the true population: the shape requires an exec AND a recognised official read in the SAME file, so a
//   helper-mediated read is invisible — measured at zero in R579, but zero for that denominator only.
//   Not that the 42 should each be investigated: they are a population, not a defect list. What the number establishes is
//   that the four green groups in R563 were not a survey.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CENSUS, SCOPE, MISSING_LEDGER_COLUMN } from '../desktop/replica-population.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'replica-file-census.cjs');

const runCensus = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the census failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the census re-derives the population and the split sums', () => {
  const d = runCensus();
  assert.ok(d.replicaShaped > 10, `only ${d.replicaShaped} replica-shaped files`);
  assert.equal(d.visibleToListDetector + d.invisibleToListDetector, d.replicaShaped,
    'visible + invisible does not equal the population');
  assert.equal(d.percentInvisible, Math.round(d.invisibleToListDetector / d.replicaShaped * 100));
});

test('the invisible majority is real, not a rounding of a small sample', () => {
  const d = runCensus();
  assert.ok(d.invisibleToListDetector > d.visibleToListDetector,
    `invisible ${d.invisibleToListDetector} is not greater than visible ${d.visibleToListDetector}`);
  assert.ok(d.percentInvisible >= 50,
    `only ${d.percentInvisible}% invisible: the container might be adequate after all`);
});

test('the recorded census still matches the tool', () => {
  const d = runCensus();
  // Allow the population to grow as tests are added, but not to shrink below what was recorded.
  assert.ok(d.replicaShaped >= CENSUS.replicaShapedFiles,
    `the census now finds ${d.replicaShaped}, fewer than the recorded ${CENSUS.replicaShapedFiles}`);
  assert.ok(d.invisibleToListDetector >= CENSUS.invisibleToListDetector,
    `the invisible count fell from ${CENSUS.invisibleToListDetector} to ${d.invisibleToListDetector}`);
});

test('the example file is invisible to the list detector', () => {
  const d = runCensus();
  const row = d.rows.find((r) => r.file === 'cli-mcp-host-sources-r378.test.mjs');
  assert.ok(row, 'the example file is not replica-shaped by the census');
  assert.equal(row.inListGroup, false,
    'the example file now appears in a list group, so it no longer demonstrates the gap');
});

test('the scope is stated as narrower than the name suggests', () => {
  assert.match(SCOPE.answers, /repeated LIST/, 'the tool\'s actual subject is not stated');
  assert.match(SCOPE.doesNotAnswer, /which test files/, 'the question it cannot answer is not stated');
  assert.match(SCOPE.why, /never visited|repeated-list sites/, 'the reason for the gap is not stated');
});

test('the four-round pattern is named, and the ledger column it lacked', () => {
  assert.equal(MISSING_LEDGER_COLUMN.column, 'what the detector\'s key is a property OF');
  const names = MISSING_LEDGER_COLUMN.examples.map((e) => e.tool);
  assert.ok(names.includes('group-provenance'), 'this round\'s tool is not in the example list');
  assert.match(MISSING_LEDGER_COLUMN.examples.find((e) => e.tool === 'group-provenance').drifted,
    /was being read as/, 'the drift is not described');
});

test('the ledger column is recorded rather than retrofitted', () => {
  // R576's ledger must NOT have gained a subject column as part of this round: retrofitting a ledger to justify a
  // conclusion is how ledgers stop being evidence.
  const ledger = fs.readFileSync(path.join(ROOT, 'desktop', 'detector-keys.cjs'), 'utf8');
  assert.ok(!/subject:/i.test(ledger),
    'a subject column was retrofitted into the R576 ledger; the observation belongs in this round\'s file');
});

test('the population is not presented as a defect list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'replica-population.cjs'), 'utf8');
  assert.ok(/population, not a defect list/.test(src), 'the caveat is missing');
  assert.ok(/not a survey|are not a survey/.test(src), 'the implication for R563 is not stated');
});
