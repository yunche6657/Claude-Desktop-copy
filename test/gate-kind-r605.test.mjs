// R605: the four tools at emit/flag ratio 1.00 reach it for different reasons — a data predicate, or a placement proxy.
//
// THE FOUR AND THEIR GATES (read from each tool's source)
//       R590  set-lifetimes        addOnly: has+add, no delete/clear
//       R595  clear-asymmetry      hasReset differs + fedIn equal + co-mentioned on a line
//       R600  source-divergence    one internal AND one external assignment (+ two shape gates)
//       R602  denial-vs-witness    same file + same function + different line + not minified
//
// WHICH ARE STRUCTURAL, WHICH ARE POSITIONAL
//       structural   a predicate over the DATA: `a.hasReset !== b.hasReset`, `hasInternal && hasExternal`
//       positional   a predicate over WHERE code sits: `w.fn === d.fn`, `coMentioned(...)`, `avgLine > 400`
//
//   R595, the one-row tool, has TWO structural load-bearing gates: one set has a reset and the other does not; both are fed
//   inside one function. The third gate is positional and only admits the pair — the population reduction comes from the first
//   two.
//
//   R600's load-bearing gate is structural: a variable must have one internal AND one external assignment, which is a fact about
//   provenance rather than placement. Its 21 rows are 21 variables that genuinely have both.
//
//   R602's load-bearing gates are all positional. Nothing compares the two comments' content. Its 14 pairs are 14 places where two
//   comments share a large function — which is exactly why all 14 were noise.
//
// THE RULE
//   A ratio of 1.00 is reachable when the filtering gate is a predicate over DATA, because then "row emitted" and "condition
//   true" are the same statement, and a false row would require the data to lie.
//
//   It is not reachable when the gate is positional, because position is a proxy: two comments in one function have no reason to
//   concern one subject, and 14 of them did not.
//
// WHAT R595 ACTUALLY BOUGHT, STATED HONESTLY
//   One row, and it is R590's pair. The gate did not DISCOVER it — R590 had found it by another route. What R595 established is
//   that the criterion has a second, sharper form: both keys omit the dimension AND only one side is cleared. A one-row tool
//   whose row was already known is not wasted, but it is not a discovery either, and the difference matters for how much weight
//   the criterion gets.
//
// WHAT IS NOT CLAIMED
//   Not that positional gates are useless: R602's enumeration — the 44 denials and 42 witnesses — is what made any comparison
//   possible. The gate that FILTERS is positional; the enumeration underneath it is not.
//   Not that structural gates are always right: R594's `agrees` gate was structural (compare the two key expressions) and still
//   produced 55 false rows, because "the expressions differ" is structural but does not imply "the keys are wrong".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, RULE } from '../desktop/gate-kind.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('each of the four records its gates and a load-bearing kind', () => {
  assert.equal(TOOLS.length, 4);
  for (const t of TOOLS) {
    assert.ok(t.gates.length >= 1, `${t.round} records no gates`);
    assert.ok(['structural', 'positional'].includes(t.loadBearing), `${t.round} has loadBearing ${t.loadBearing}`);
    for (const g of t.gates) assert.ok(['structural', 'positional'].includes(g.kind), `${t.round}: ${g.text}`);
  }
});

test('the gates recorded are the gates the tools actually apply', () => {
  // Each assertion quotes a `continue`-gated condition that must still exist in the named file.
  const expected = [
    { file: 'tools/set-lifetimes.cjs', fragment: 'if (!addOnly) continue;' },
    { file: 'tools/clear-asymmetry.cjs', fragment: 'if (a.hasReset === b.hasReset) continue;' },
    { file: 'tools/clear-asymmetry.cjs', fragment: 'if (!a.fedIn || a.fedIn !== b.fedIn) continue;' },
    { file: 'tools/clear-asymmetry.cjs', fragment: 'if (!line) continue;' },
    { file: 'tools/source-divergence.cjs', fragment: 'if (!hasInternal || !hasExternal) continue;' },
    { file: 'tools/source-divergence.cjs', fragment: 'if (sites.length < 2) continue;' },
    { file: 'tools/denial-vs-witness.cjs', fragment: 'if (w.file !== d.file) continue;' },
    { file: 'tools/denial-vs-witness.cjs', fragment: 'if (w.fn !== d.fn) continue;' },
    { file: 'tools/denial-vs-witness.cjs', fragment: 'if (w.line === d.line) continue;' },
  ];
  for (const e of expected) {
    const src = fs.readFileSync(path.join(ROOT, e.file), 'utf8');
    assert.ok(src.includes(e.fragment), `${e.file} no longer contains: ${e.fragment}`);
  }
});

test('R595 is structural on its load-bearing gates and positional on the admitting one', () => {
  const r595 = TOOLS.find((t) => t.round === 'R595');
  assert.equal(r595.loadBearing, 'structural');
  const kinds = r595.gates.map((g) => g.kind);
  assert.equal(kinds.filter((k) => k === 'structural').length, 2, 'R595 no longer has two structural gates');
  assert.equal(kinds.filter((k) => k === 'positional').length, 1, 'R595 no longer has exactly one positional gate');
});

test('R602 is positional on every load-bearing gate', () => {
  const r602 = TOOLS.find((t) => t.round === 'R602');
  assert.equal(r602.loadBearing, 'positional');
  assert.ok(r602.gates.every((g) => g.kind === 'positional'), 'R602 now has a structural gate');
});

test('the rule states the mechanism, not just the correlation', () => {
  assert.match(RULE.why, /same statement/, 'the mechanism is not stated');
  assert.match(RULE.failsWhen, /proxy/, 'the failure mode is not named as a proxy');
  assert.match(RULE.evidence, /all 14 are noise/, 'the counter-example is not cited');
});

test('R595 is described as confirming rather than discovering', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'gate-kind.cjs'), 'utf8');
  assert.match(src, /did not DISCOVER it|already known/, 'the admission that the row was already found is missing');
  assert.match(src, /not a discovery either/, 'the consequence is not drawn');
});

test('both caveats about the rule are present', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'gate-kind.cjs'), 'utf8');
  assert.match(src, /Not that positional gates are useless/, 'the positional caveat is missing');
  assert.match(src, /R594's `agrees` gate was structural/, 'the structural counter-example is missing');
});
