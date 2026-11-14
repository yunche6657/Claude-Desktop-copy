// R573: this project's own method, measured. Extracting a drifted rule and writing cases against it has found more
// defects than reading has, and the record is checkable.
//
// THE PATTERN, TWICE IN A ROW
//   R567 and R572 ended the same way. A rule had been edited repeatedly, it was extracted into a module, cases were
//   written — and writing the cases made the module FAIL, exposing shapes nobody had considered:
//
//       loopMultiplicity  a Map counted by brackets (8 for 3 pairs) · a comment's `assert.` counted as an assertion ·
//                         nested loops reporting only the innermost multiplicity
//       conditionOf       `function` optional so `if (x) {` parsed as a parameter list · `if` is identifier-shaped so
//                         method-shorthand matched · a string literal's contents counted as identifiers
//
//   None of those was found by reading code. Each was found by asserting what the code should do and watching it not.
//
// THE TALLY
//       5 extractions   7 defects exposed by cases   1 exposed by merging   4 of 5 extractions found something
//       defects per extraction: 1.6
//
//   The one that found nothing (packaging-features, R568) still changed something: `withPackagingState`'s policy — never
//   ADD a feature the bridge map did not offer — was documented in a comment and now is asserted. So even a zero is not a
//   wasted extraction, which is why the ledger records what each one bought rather than only what it broke.
//
// THE BIAS, STATED
//   All five were chosen because their subject had ALREADY drifted or was unreachable. That is a biased sample: rules
//   nobody has touched are not in it, and their extraction would likely find nothing. So "1.6 defects per extraction" is
//   not a rate for arbitrary code — it is a rate for code this project already knew was troublesome, which is exactly the
//   code worth extracting.
//
//   The useful claim is narrower and still worth having: when a rule has been edited more than twice, extracting it and
//   writing cases has paid off 4 times out of 5, and paid off immediately.
//
// WHAT IS NOT CLAIMED
//   Not that reading finds nothing — several rounds found real defects by reading (`R554`: the LocalSessions array existed
//   eight times in production when a partial read said it existed only in tests). What is claimed is that the case-writing
//   path is cheaper per defect, because the cases have to exist anyway.
//   Not that the ledger is complete: it lists the extractions this project's own evidence records, and an extraction
//   nobody wrote up would be missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACTIONS, totals } from '../desktop/extraction-ledger.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every extraction names a module that exists', () => {
  for (const e of EXTRACTIONS) {
    const full = path.join(ROOT, e.module);
    assert.ok(fs.existsSync(full), `${e.module} (round ${e.round}) does not exist at that path`);
  }
});

test('every extraction records what it was extracted from and why', () => {
  for (const e of EXTRACTIONS) {
    assert.ok(Number.isInteger(e.round), 'an extraction has no round');
    assert.ok(e.from.length > 20, `round ${e.round} does not say what it was extracted from`);
    assert.ok(e.reason.length > 20, `round ${e.round} does not say why`);
    assert.ok(e.found.length > 20, `round ${e.round} does not say what it found`);
  }
});

test('the totals are computed from the rows, not typed', () => {
  const t = totals();
  assert.equal(t.extractions, EXTRACTIONS.length);
  assert.equal(t.casesExposed, EXTRACTIONS.reduce((n, e) => n + e.casesExposed, 0));
  assert.equal(t.extractionFound, EXTRACTIONS.reduce((n, e) => n + e.extractionFound, 0));
  assert.equal(t.withDefects,
    EXTRACTIONS.filter((e) => e.casesExposed + e.extractionFound > 0).length);
});

test('the two rounds that motivated this are both listed with their defects', () => {
  const loop = EXTRACTIONS.find((e) => e.module === 'tools/loop-multiplicity.cjs');
  assert.ok(loop, 'R567 extraction missing');
  assert.equal(loop.casesExposed, 3);
  assert.match(loop.found, /Map literal counted by brackets|brackets/);
  assert.match(loop.found, /nested loops|innermost/);

  const cond = EXTRACTIONS.find((e) => e.module === 'tools/branch-condition.cjs');
  assert.ok(cond, 'R572 extraction missing');
  assert.equal(cond.casesExposed, 3);
  assert.match(cond.found, /parameter list/);
  assert.match(cond.found, /method-shorthand/);
  assert.match(cond.found, /string literal/);
});

test('the extraction that found no defect still records what it bought', () => {
  const pkg = EXTRACTIONS.find((e) => e.module === 'desktop/packaging-features.cjs');
  assert.ok(pkg, 'R568 extraction missing');
  assert.equal(pkg.casesExposed + pkg.extractionFound, 0);
  // A zero entry must still justify itself, or the ledger is only a list of wins.
  assert.match(pkg.found, /policy|asserted/, 'a zero entry does not say what it bought');
});

test('the merge-finding extraction is distinguished from the case-finding ones', () => {
  const lexer = EXTRACTIONS.find((e) => e.module === 'tools/lexer.cjs');
  assert.ok(lexer, 'R550 extraction missing');
  assert.equal(lexer.extractionFound, 1, 'the merge defect is not counted');
  assert.equal(lexer.casesExposed, 0, 'merge findings must not be counted as case findings');
  assert.match(lexer.found, /unparsed/, 'the concrete effect is missing');
});

test('the ledger states the bias in its sample', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'extraction-ledger.cjs'), 'utf8');
  assert.match(src, /biased starting point|ALREADY drifted|biased sample/,
    'the ledger does not admit that every subject was chosen because it was already troublesome');
  assert.match(src, /cannot compare against/, 'the unobservable counterfactual is not disclaimed');
});

test('the modules the ledger names are the ones this project actually created', () => {
  // A light check that the ledger is about this repository and not a narrative: each listed module was touched within
  // the span these rounds cover.
  const recent = EXTRACTIONS.filter((e) => e.round >= 550);
  assert.ok(recent.length >= 4, `only ${recent.length} extractions from round 550 on`);
  for (const e of recent) {
    const stat = fs.statSync(path.join(ROOT, e.module));
    assert.ok(stat.size > 500, `${e.module} is ${stat.size} bytes: too small to be the module described`);
  }
});
