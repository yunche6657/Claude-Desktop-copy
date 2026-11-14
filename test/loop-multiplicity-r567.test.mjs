// R567: the loop analysis is now a pure module with fixed cases, because in one round it was changed three times.
//
// THE THREE CHANGES THAT FORCED THIS
//   R566 edited one internal function three times, each time because it had never been given a shape:
//
//     1. `for (const x of NAME)` did not match `for (const [name, [file]] of GUARDS)` — nested destructuring.
//        The first fix tried `\[[^\]]*\]`, which stops at the first `]` INSIDE `[file, line]`.
//     2. A `new Map([...])` multiplicity was not read, so a 14-guard loop counted as 1.
//     3. The scope was closed by `^\}\);?\s*$`, which fired on the wrong brace and cleared the multiplicity before the
//        assertion it should have multiplied. The brace-depth fix then double-counted the `for` line and closed the loop
//        on the line that opened it.
//
//   None of these was a mistake about loops. Each was a function answering a question it had not been tested on. R550
//   answered the same situation for four divergent `blank()` copies by extracting one implementation; this does the same
//   and adds the cases that name the shapes.
//
// FIXED CASES BELOW, all synthetic
//   multiplicity:   a stated `.size`/`.length`, a Map literal, a Set literal, an array literal, an unknown name, and a
//                   name that is not an identifier at all (which must not be fed to `new RegExp`)
//   assertCount:    one per occurrence — six on one line is six
//   scanLoops:      nested destructuring, a loop closed by its own brace, a loop containing a second loop, and an
//                   assertion after a loop ends (which must NOT be multiplied)
//   analyse:        the 14-guard file's real shape, and the six-on-one-line file's
//
// WHAT IS NOT CLAIMED
//   Not that this parses JavaScript: braces and quotes inside regex literals are counted as braces and quotes. The
//   consequence is bounded and reported — `depthUncertain` is set when a line holds a brace inside a string, and a wrong
//   depth can only change a loop's multiplicity, never the occurrence count of an assertion.
//   Not that the cases are exhaustive. They are the four shapes that actually broke, plus the two the module had.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isName, multiplicity, assertCount, scanLoops, analyse } from '../tools/loop-multiplicity.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a name that is not an identifier is refused before it reaches new RegExp', () => {
  // `new RegExp` was once built from a fragment containing brackets and braces and threw "Range out of order".
  for (const bad of ['[a,b', '{x}', 'a.b', 'a b', '', '1abc', "a'b"]) {
    assert.equal(isName(bad), false, `${JSON.stringify(bad)} was accepted as a name`);
    assert.equal(multiplicity('', bad), 1, `${JSON.stringify(bad)} produced something other than 1`);
  }
  for (const good of ['GUARDS', '_x', '$y', 'a1']) assert.equal(isName(good), true, good);
});

test('multiplicity reads a STATED size first', () => {
  // An assertion that states the size is the strongest evidence: the test already committed to that number.
  assert.equal(multiplicity('assert.equal(GUARDS.size, 14);', 'GUARDS'), 14);
  assert.equal(multiplicity('assert.equal(list.length, 7);', 'list'), 7);
  // Without the assertion wrapper, the same literals still work.
  assert.equal(multiplicity('expect(x.size, 3);', 'x'), 3);
});

test('multiplicity counts a Map literal by its pairs, not its brackets', () => {
  const map = "const G = new Map([['a', ['f', 'x']], ['b', ['g', 'y']], ['c', ['h', 'z']]]);";
  assert.equal(multiplicity(map, 'G'), 3,
    'a nested pair was counted as two entries, or the count came from the wrong bracket');
});

test('multiplicity counts Set and array literals by their quoted items', () => {
  assert.equal(multiplicity("const S = new Set(['a','b','c','d']);", 'S'), 4);
  assert.equal(multiplicity("const A = ['a','b'];", 'A'), 2);
});

test('an unknown collection falls back to 1, which is a lower bound rather than a guess', () => {
  assert.equal(multiplicity('for (const g of SOMETHING_ELSE) {}', 'GUARDS'), 1);
  assert.equal(multiplicity('', 'GUARDS'), 1);
});

test('assertions are counted per occurrence, not per line', () => {
  assert.equal(assertCount("try{assert.equal(a,1);assert.deepEqual(b,[]);assert.ok(c);}finally{}"), 3);
  assert.equal(assertCount('  assert.equal(a, 1);'), 1);
  assert.equal(assertCount('  // assert.equal is mentioned only in this comment'), 0,
    'a bare `assert.` in a comment is not a call (the `(` is what makes it one — see the note below)');
});

test('a destructured loop variable is found, including a nested pattern', () => {
  const text = [
    'for (const [name, [file, line]] of GUARDS) {',
    '  if (x) assert.ok(name);',
    '}',
  ].join('\n');
  const r = scanLoops(text);
  assert.equal(r.perLine.length, 1);
  assert.equal(r.perLine[0].collection, 'GUARDS',
    'the nested destructuring pattern defeated the loop match');
  assert.equal(r.perLine[0].runs, 1, 'GUARDS has no literal in this text, so the multiplicity is the floor of 1');
});

test('a loop closes at its own brace, not at the first closing line', () => {
  const text = [
    'for (const [a, [b]] of LIST) {',
    '  assert.ok(a);',
    '}',
    'assert.equal(1, 1);',
  ].join('\n');
  const r = scanLoops(text);
  assert.equal(r.perLine.length, 2);
  assert.equal(r.perLine[0].collection, 'LIST', 'the assertion inside the loop lost its loop');
  assert.equal(r.perLine[1].collection, null, 'the assertion AFTER the loop was still counted as inside it');
});

test('a loop containing a loop multiplies by the inner collection', () => {
  const text = [
    'const OUTER = [1, 2, 3];',
    'const INNER = [1, 2];',
    'for (const o of OUTER) {',
    '  for (const i of INNER) {',
    '    assert.ok(o, i);',
    '  }',
    '  assert.ok(o);',
    '}',
  ].join('\n');
  const a = analyse(text);
  // inner assertion runs 3*2 = 6, the outer-only one runs 3, total 9.
  assert.equal(a.assertions, 2);
  assert.equal(a.factsLowerBound, 9, `expected 3*2 + 3 = 9, got ${a.factsLowerBound}`);
});

test('the 14-guard file reports the shape that motivated the extraction', () => {
  const text = fs.readFileSync(path.join(ROOT, 'test', 'security-guards.test.mjs'), 'utf8');
  const a = analyse(text);
  assert.equal(a.assertions, 3, 'the assertion count changed');
  assert.ok(a.loopAssertions >= 1, 'no assertion was attributed to a loop');
  assert.ok(a.ratio > 3, `ratio is ${a.ratio}: the 14-guard loop is not multiplying`);
});

test('the six-on-one-line file reports six assertions', () => {
  const text = fs.readFileSync(path.join(ROOT, 'test', 'hybrid-bootstrap-runtime-gate-r378.test.mjs'), 'utf8');
  const a = analyse(text);
  assert.equal(a.assertions, 6, 'the per-line rule is back');
  assert.equal(text.split('\n').filter((l) => /\bassert\./.test(l)).length, 1,
    'the file no longer has all six on one line, so this case no longer demonstrates anything');
});

test('the reporting tool delegates and adds nothing of its own', () => {
  // The point of the extraction: one implementation of the analysis.
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'assertion-strength.cjs'), 'utf8');
  assert.match(src, /require\('\.\/loop-multiplicity\.cjs'\)/, 'the tool does not import the module');
  assert.ok(!/new RegExp/.test(src), 'the tool still builds its own patterns: the logic has not moved');
  assert.ok(!/brace\s*\+=/.test(src), 'the tool still tracks braces itself');
});
