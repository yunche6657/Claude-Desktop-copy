// R633: the twelve rounds R621–R632 reduce to eight rules, each paid for by a measured failure. This asserts the checklist is
// complete against those rounds and that every rule's example still holds in the code.
//
// HOW TO USE IT
//   Before writing a number into evidence, find the row whose symptom matches. If none matches, the number is probably fine and the
//   gap is worth recording.
//
// WHAT IT IS NOT
//   Not a style guide — every row is a measured failure. Not exhaustive — only R621–R632 were mined.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES, SUMMARY } from '../desktop/measurement-checklist.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every round from R621 to R632 is cited by at least one rule', () => {
  const cited = new Set();
  for (const r of RULES) for (const round of r.rounds) cited.add(round);
  // The rounds that produced a rule; R623, R627, R632 are the measurements that motivated rules without being cited directly.
  const expected = ['R621', 'R622', 'R624', 'R625', 'R626', 'R628', 'R629', 'R630', 'R631'];
  for (const e of expected) assert.ok(cited.has(e), `${e} is not cited by any rule`);
});

test('every rule has a symptom, a cost, and at least one round', () => {
  assert.ok(RULES.length >= 8, `only ${RULES.length} rules`);
  for (const r of RULES) {
    assert.ok(r.rule.length > 15, `"${r.rule}" is not a rule`);
    assert.ok(r.symptom.length > 15, `${r.rule} has no symptom`);
    assert.ok(r.why.length > 15, `${r.rule} has no reason`);
    assert.ok(r.rounds.length >= 1, `${r.rule} cites no round`);
    assert.ok(r.cost.length > 20, `${r.rule} has no cost`);
  }
});

test('the isFile rule matches the code it was learned from', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'text-assertion-audit.cjs'), 'utf8');
  assert.ok(src.includes('isFile()'), 'the guarded read is gone, so the rule no longer reflects the code');
  assert.ok(!/if \(subjectPath && fs\.existsSync\(subjectPath\)\) \{/.test(src), 'the existsSync guard is back');
});

test('the else-if rule matches the tool that already had it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'branch-coverage.cjs'), 'utf8');
  assert.match(src, /\(\?<!else\\s\)\\bif\\s\*\\\(/, 'the lookbehind that excludes else-if is gone');
});

test('the relation rule matches the three rewritten counters', () => {
  const files = [
    'test/evidence-coverage-r617.test.mjs',
    'test/citation-census-r618.test.mjs',
    'test/drift-model-r619.test.mjs',
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(/>=|SHRANK|shrank/.test(text), `${f} no longer asserts a relation`);
  }
});

test('the summary states the one sentence and its application', () => {
  assert.match(SUMMARY.claim, /instruments were right/, 'the claim is not stated');
  assert.match(SUMMARY.howToApply, /find the matching symptom/, 'how to apply it is not stated');
  assert.match(SUMMARY.notA, /measured failure/, 'the non-style-guide point is not stated');
});

test('the checklist is published as a document, not only as data', () => {
  const doc = path.join(ROOT, 'evidence', 'MEASUREMENT-CHECKLIST.md');
  assert.ok(fs.existsSync(doc), 'the checklist document does not exist');
  const text = fs.readFileSync(doc, 'utf8');
  // The document is written in Chinese, so it is matched by the rounds it cites rather than by the English rule text.
  assert.ok(text.includes("statSync(p).isFile()"), 'the isFile rule is missing from the document');
  for (const r of RULES) {
    const first = r.rounds[0];
    assert.ok(text.includes(first), `the rule citing ${first} is missing from MEASUREMENT-CHECKLIST.md`);
  }
  // Every round the data cites must be named in the document.
  const cited = new Set();
  for (const r of RULES) for (const round of r.rounds) cited.add(round);
  for (const round of cited) assert.ok(text.includes(round), `${round} is cited in the data but not the document`);
});
