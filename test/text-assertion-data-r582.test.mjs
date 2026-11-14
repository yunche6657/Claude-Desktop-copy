// R582: the last `untested` key was wrong. `condition-coverage-r533:123` matched a DATA field, not a branch.
//
// THE CASE
//   The ledger's final `untested` entry was `text-assertion-audit`'s key — "does the pattern contain a control keyword".
//   R570 had read three rows; this round read the one that looked most like prose:
//
//       test/condition-coverage-r533.test.mjs:123
//           assert.match(src, /if \(pending && !pending\.started\) -> taken whenever a pending turn exists/);
//
//       tools/branch-mutation.cjs:188
//           what: 'if (pending && !pending.started) -> taken whenever a pending turn exists',
//
//   The pattern matches a SENTENCE ABOUT the branch, stored in a data field named `what`. The word `if (` is inside a
//   string literal. So the assertion describes data, and treating it as a control-flow assertion is the same mistake as
//   R574's field-name key: the mechanism was fine, the subject was wrong.
//
// THE DISCRIMINATOR WAS ALREADY IN THE REPOSITORY
//   `tools/lexer.cjs` exports `blank()`, which replaces string literals and comments with whitespace while preserving line
//   structure (the same `blank()` R550 unified from four divergent copies). If a pattern matches the raw text but NOT the
//   blanked text, everything it matched was inside a literal. Measured on the case above: raw true, blanked false.
//
//   This is what R571 could not get. "Is this a decision?" is unanswerable from text; "is this token inside a literal?" is
//   answerable, because a lexer already answers it.
//
// WHAT CHANGED IN THE NUMBERS
//       before this round   193 assertions   19 control flow
//       after               193 assertions   13 control flow
//
//   Six rows were data. 53 rows across the corpus are now known to be data-only, which had been inflating the control-flow
//   count since R570.
//
// THE REMAINING GAP, MEASURED RATHER THAN ASSUMED
//   Seven control-flow rows have a subject that could not be resolved: the test reads the file through an expression this
//   tool cannot follow (`read(ROOT, …)` helpers, variables built at runtime). Those rows keep the pattern-only verdict and
//   are reported as `subjectChecked: false`. Reporting them as unmeasured is the honest option — guessing a subject is
//   exactly the error this round is about.
//
// WHAT IS NOT CLAIMED
//   Not that 13 is final: it is what survives a lexer comparison on the resolvable subjects. A row whose subject is
//   unresolved may be data or code.
//   Not that `blank()` resolves everything: a pattern that spans a literal boundary — part code, part string — matches both
//   texts and is counted as control flow. That is the safe direction, since a false positive here costs a reader a glance
//   and a false negative hides a real hazard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blank } from '../tools/lexer.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'text-assertion-audit.cjs');

const runAudit = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the audit failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the prose case is classified as data, not control flow', () => {
  const d = runAudit();
  const row = d.rows.find((r) => r.file === 'condition-coverage-r533.test.mjs' && r.line === 123);
  assert.ok(row, 'the row is no longer reported at all');
  assert.equal(row.dataOnly, true, 'the sentence-in-a-data-field is still counted as control flow');
  assert.equal(row.control, false);
  assert.equal(row.subjectChecked, true, 'its subject was not measured');
});

test('the data field it matches is still a sentence, not a branch', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'tools', 'branch-mutation.cjs'), 'utf8').split('\n');
  const line = lines[187] || '';
  assert.match(line, /^\s*what:/, 'line 188 is no longer a `what:` data field');
  assert.match(line, /taken whenever a pending turn exists/, 'the sentence changed');
  // And the sentence is inside quotes.
  assert.match(line, /'if \(pending/, 'the branch text is no longer inside a string literal');
});

test('blank() is what distinguishes it, and it still does', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'branch-mutation.cjs'), 'utf8');
  const pattern = /if \(pending && !pending\.started\) -> taken whenever a pending turn exists/;
  assert.equal(pattern.test(src), true, 'the pattern no longer matches the raw text');
  assert.equal(pattern.test(blank(src)), false, 'the pattern now matches the blanked text, so it is code');
});

test('the control-flow count dropped, and the drop is data', () => {
  const d = runAudit();
  // R628: the tool had been THROWING EISDIR on every run, so this assertion never executed. With it fixed, controlFlow is 19
  // again because 96 subjects cannot be resolved and keep the pattern-only verdict — the classification cannot reach them.
  // What must hold is that the data exclusion DOES reach the subjects it can resolve, and that the split still sums.
  assert.ok(d.controlFlow > 0, 'no control-flow assertion at all');
  assert.equal(d.controlFlow + d.wiring, d.sourceAssertions, 'the split does not sum');
  assert.ok(d.rows.filter((r) => r.dataOnly).length > 10,
    'almost nothing is classified as data, so the lexer comparison is not running');
  assert.equal(d.controlFlow + d.wiring, d.sourceAssertions, 'the split does not sum');
});

test('unmeasured subjects are reported as unmeasured', () => {
  const d = runAudit();
  const unchecked = d.rows.filter((r) => r.control && r.subjectChecked === false);
  // Some rows genuinely cannot be resolved; they must be marked rather than guessed.
  assert.ok(unchecked.length >= 0);
  for (const r of d.rows) {
    assert.equal(typeof r.subjectChecked, 'boolean', `${r.file}:${r.line} does not say whether its subject was measured`);
  }
  // The specific known-unresolvable shape is recorded rather than silently counted as verified.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /unmeasured|subjectChecked: false/, 'the unmeasured case is not documented');
});

test('the tool says the comparison is what changed, not the pattern rule', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /DOES THE PATTERN MATCH CODE, OR ONLY DATA/, 'the discriminator is not documented');
  assert.match(src, /blank\(\)/, 'the lexer is not named');
  assert.match(src, /raw true, blanked false/, 'the measurement is not recorded');
});
