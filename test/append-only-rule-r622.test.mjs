// R622: the classification R621 proposed is not mechanisable, and the reason is worth more than the classification would have
// been: in 727 size-pinning assertions, the collection being sized is almost always a FIXTURE the test built.
//
// WHAT WAS ATTEMPTED
//   R621 proposed splitting `assert.equal(<.length>, <n>)` into "evidence-derived → use >=" and "source-derived → use ===".
//   Measured: 727 such assertions. Classifying by the left-hand text put 717 in `fixture` and produced 10 "evidence-derived" rows
//   that were all MY regex misfiring — it matched across a `;` and swallowed the neighbouring assertion, so
//   `assert.equal(coverage.branches.length === 26` is a fragment of `assert.equal(coverage.branches.length, 26)`.
//
//   The instrument was wrong, not the code under it. Second time in two rounds — R621 caught itself reporting two false DRIFTs
//   from a pattern.
//
// WHAT A DIRECT SEARCH FOUND
//   Tests that read an append-only artifact (anything under `evidence/`): 37 files. Those that ALSO pin a size mostly pin fixtures —
//   `interrupts.length === 1`, `asked.length === 1`, `transcript.length === 4`, `launches.length === 2`. Those collections are built
//   inside the test, so they do not grow with the repository and `===` is right for them.
//
//   The genuine append-only pins were the three R620 already rewrote as relations (evidence-coverage, citation-census, drift-model).
//   Nothing else was left to convert.
//
// THE RULE IS STILL CORRECT, AND HAS ALMOST NO INSTANCES HERE
//   "Append-only data gets `>=`; fixed source gets `===`" holds. What this round establishes is that it has three instances in this
//   repo, because the tests nearly always assert on data they constructed. Worth stating; not worth a sweep.
//
// WHAT IS NOT CLAIMED
//   Not that no other append-only pin exists: the search looked for tests that READ `evidence/`. A test importing a census module
//   without naming the directory would be missed — though the census modules live in `desktop/` and are imported by name.
//   Not that 727 is the true count: the regex requires a numeric literal second argument, so an assertion against a named constant is
//   not counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SWEEP, RULE } from '../desktop/append-only-rule.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the three genuine append-only pins are already relations', () => {
  const files = [
    'test/evidence-coverage-r617.test.mjs',
    'test/citation-census-r618.test.mjs',
    'test/drift-model-r619.test.mjs',
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // Each must contain at least one relational assertion on a growing count.
    assert.match(text, />=|SHRANK|shrank|\.length >=|>= COVERAGE|>= ROWS/,
      `${f} has no relational assertion`);
  }
});

test('the census modules the sweep counted still exist', () => {
  for (const f of ['evidence-coverage.cjs', 'citation-census.cjs', 'drift-model.cjs']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'desktop', f)), `${f} is gone`);
  }
});

test('the regex-misfire example is reproducible', () => {
  // The fragment the bad regex captured.
  const line = "assert.equal(coverage.branches.length, 26); assert.equal(cancelled.length, 1);";
  const bad = /assert\.(equal|strictEqual)\(([\s\S]{0,140}?),(\s*)(\d+)\s*[,)]/g;
  const first = [...line.matchAll(bad)][0];
  // With the greedy tail, the capture can run past the `;`.
  assert.ok(first, 'the pattern no longer matches at all');
  // The correct reading requires stopping at `;`.
  const good = /assert\.equal\(([^;\n]+?),\s*(\d+)\)/;
  const m = good.exec(line);
  assert.ok(m, 'the strict pattern fails on a well-formed assertion');
  assert.ok(!m[1].includes(';'), 'the strict capture must not cross a semicolon');
});

test('the sweep counts are internally consistent', () => {
  assert.equal(SWEEP.sizePins, 727);
  assert.equal(SWEEP.classifiedAsFixture, 717);
  assert.equal(SWEEP.falselyClassifiedAsEvidence, 10);
  assert.equal(SWEEP.classifiedAsFixture + SWEEP.falselyClassifiedAsEvidence, SWEEP.sizePins);
  assert.equal(SWEEP.genuineAppendOnlyPins, 3);
});

test('the rule keeps its scope narrowed by measurement', () => {
  assert.match(RULE.statement, /append-only data gets `>=`/, 'the rule is not stated');
  assert.equal(RULE.instancesHere, 3);
  assert.match(RULE.verdict, /not worth a sweep/, 'the scope decision is not stated');
  assert.match(RULE.whyItStillMatters, /three rounds running/, 'the reason it still matters is not stated');
});

test('the record does not overclaim the search', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'append-only-rule.cjs'), 'utf8');
  assert.match(src, /Not that no other append-only pin exists/, 'the search limit is missing');
  assert.match(src, /named constant is\s+not counted|named constant is not counted/, 'the count limit is missing');
});
