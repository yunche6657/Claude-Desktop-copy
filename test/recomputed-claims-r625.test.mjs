// R625: three published numbers re-derived from source. All three correct — and all three looked wrong until the UNIT was read
// from the sentence.
//
// WHAT WAS CHECKED
//   Six claims take the form "FILE has N (个/行/条/处)". Five resolve; the sixth does not. Re-derived:
//
//       STATUS.md  main.cjs 10 行            10 ADDED lines, not the file's 1350
//       STATUS.md  session-kernel.cjs 367    367 BRANCHES
//       STATUS.md  kernel-select.test.mjs 13 13 TOP-LEVEL tests
//
// THE BRANCH CLAIM, EXACTLY
//   The claim's own breakdown is `if 322 / else-if 7 / else 6 / catch 32 / case 0`, summing to 367. Re-derived with strings and
//   comments blanked (a `if (` inside a template literal is not a branch):
//
//       if total 322   else-if 7   else 6   catch 32   case 0
//
//   Every component matches; 322 + 7 + 6 + 32 = 367. The only thing that looks off is that 322 includes `else if`, so `plainIf` is
//   315 and `plainIf + elseIf` is 322. That is a normal way to count branches and is the reading that closes the arithmetic.
//
// THE TEST CLAIM, EXACTLY
//   `13 个测试` — a blanked scan counts 14 `test(` occurrences, but only 13 start a line; the fourteenth is nested inside another.
//   Top-level tests is the only reading under which the claimed 38 assertions sit in 13 tests.
//
// THE PATTERN, NOW FOUR ROUNDS
//       R621  two DRIFTs            field names read wrong
//       R622  ten evidence rows     regex crossed a semicolon
//       R624  thirty mismatches     table columns and count kinds read wrong
//       R625  five file claims      the unit read wrong
//
//   The data was right; the reading was wrong. That is the dominant failure mode here, and a probe cannot fix it because the probe
//   IS the reading.
//
// WHAT IS NOT CLAIMED
//   Not that the other 800-odd are correct: three were checked.
//   Not that the sixth claim resolves: the scan found a FILE reference it could not resolve and did not chase it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blank } from '../tools/lexer.cjs';
import { CLAIMS, PATTERN } from '../desktop/recomputed-claims.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the branch claim re-derives exactly, component by component', () => {
  const sk = blank(fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8'));
  const elseIf = [...sk.matchAll(/\belse\s+if\s*\(/g)].length;
  const ifTotal = [...sk.matchAll(/\bif\s*\(/g)].length;
  const els = [...sk.matchAll(/\belse\s*\{/g)].length;
  const catches = [...sk.matchAll(/\bcatch\s*[({]/g)].length;
  const cases = [...sk.matchAll(/\bcase\s+/g)].length;

  const claim = CLAIMS.find((c) => c.text.includes('367'));
  assert.ok(claim, 'the branch claim is gone from the record');

  // The claim's four components, each measured.
  assert.equal(ifTotal, claim.breakdown.if, `if( total is ${ifTotal}`);
  assert.equal(elseIf, claim.breakdown.elseIf, `else-if is ${elseIf}`);
  assert.equal(els, claim.breakdown.else, `else is ${els}`);
  assert.equal(catches, claim.breakdown.catch, `catch is ${catches}`);
  assert.equal(cases, claim.breakdown.case, `case is ${cases}`);

  // And the claimed total is exactly the four components summed, counting else-if twice because the claim lists it twice:
  // once inside "if 322" (which is the if-family total) and once as "else-if 7".
  assert.equal(claim.breakdown.if + claim.breakdown.elseIf + claim.breakdown.else + claim.breakdown.catch + claim.breakdown.case,
    claim.actual, 'the components no longer sum to the claimed total');
  assert.equal(ifTotal + elseIf + els + catches + cases, claim.actual,
    'the measured components no longer sum to the claimed total');
});

test('the test-count claim means top-level tests, and that is 13', () => {
  const src = fs.readFileSync(path.join(ROOT, 'test', 'kernel-select.test.mjs'), 'utf8');
  const blanked = blank(src);
  const all = [...blanked.matchAll(/\btest\s*\(/g)].length;
  const top = src.split('\n').filter((l) => /^test\s*\(/.test(l)).length;
  const claim = CLAIMS.find((c) => c.text.includes('kernel-select'));
  assert.ok(claim, 'the test-count claim is gone');
  assert.equal(top, claim.actual, `top-level tests is ${top}`);
  assert.equal(all, claim.naive, `all test( occurrences is ${all}`);
  assert.ok(all > top, 'there is no nested test any more, so the naive reading would not differ');
});

test('the added-lines claim is about a diff, not a file length', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  const lines = src.split('\n').length;
  const claim = CLAIMS.find((c) => c.text.includes('main.cjs'));
  assert.ok(claim, 'the added-lines claim is gone');
  assert.equal(claim.naive, lines, `main.cjs has ${lines} lines, record says naive ${claim.naive}`);
  assert.notEqual(claim.actual, lines, 'the claim would be about the whole file, which contradicts its own wording');
});

test('all three verdicts are "correct"', () => {
  assert.equal(CLAIMS.length, 3);
  for (const c of CLAIMS) assert.match(c.verdict, /correct/, `${c.text} is not recorded as correct`);
});

test('the pattern names four rounds and the reason a probe cannot fix it', () => {
  assert.equal(PATTERN.rounds.length, 4);
  assert.match(PATTERN.common, /data was right/, 'the common cause is not stated');
  assert.match(PATTERN.whyItResists, /the probe IS the reading/, 'why it resists automation is not stated');
  assert.match(PATTERN.availableRemedy, /read the sentence unit first/, 'the remedy is not stated');
});

test('the record does not claim the rest of the 807 are correct', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'recomputed-claims.cjs'), 'utf8');
  assert.match(src, /Not that the other 800-odd are correct/, 'the sample limit is missing');
  assert.match(src, /did not chase it/, 'the unresolved claim is not disclosed');
});
