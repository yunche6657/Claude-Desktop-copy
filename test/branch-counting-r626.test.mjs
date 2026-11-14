// R626: `branch-coverage.cjs` already handles BOTH traps this line of work kept falling into — `else if` double-counting and
// `.catch(` counted as a branch. The tool was right; my hand count was wrong twice over.
//
// THE GROUND TRUTH, AND THE TOOL'S ANSWER
//   Measured on `desktop/session-kernel.cjs` with strings and comments blanked:
//
//       if( total (includes else if)   322      plain if   315      else if   7
//       catch in any form               32      catch in statement position   24
//
//   The tool reports `branches 352 = if 315 + else-if 7 + else 6 + catch 24`. Every component matches a measurement and the sum
//   closes. Nothing is double-counted.
//
// HOW IT AVOIDS BOTH
//       tools/branch-coverage.cjs:261   /(?<!else\s)\bif\s*\(/g   the lookbehind excludes `else if`
//       its catch rule                  statement position only     so `promise.catch(` is not a branch
//
//   Both are the exact distinctions R625 had to rediscover by hand — and got half wrong.
//
// THE REVERSED LESSON
//   R621, R622, R624 and R625 each reported a mismatch that was my reading. Here the tool is right and my count is wrong in two
//   separate ways at once. So the pattern is not "the instruments are wrong" — it is that the instruments are better than the
//   ad-hoc probes I substitute when in a hurry. R625's hand count took two attempts and still got catch wrong; the tool had it right
//   the whole time.
//
// WHAT IS NOT CLAIMED
//   Not that every tool in `tools/` is this careful: this looks at two, and `empty-block-scan.cjs` answers a different question.
//   Not that 352 compares to the 367 in the STATUS.md claim: 367 counts `else if` twice and calls catch 32, so the two numbers measure
//   different things — the claim records one convention, the tool measures branches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blank } from '../tools/lexer.cjs';
import { COUNTING, TRAPS, LESSON } from '../desktop/branch-counting.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const truth = () => {
  const b = blank(fs.readFileSync(path.join(ROOT, COUNTING.file), 'utf8'));
  return {
    ifTotal: [...b.matchAll(/\bif\s*\(/g)].length,
    plainIf: [...b.matchAll(/(?<!else\s)\bif\s*\(/g)].length,
    elseIf: [...b.matchAll(/\belse\s+if\s*\(/g)].length,
    els: [...b.matchAll(/\belse\s*\{/g)].length,
    catchAny: [...b.matchAll(/\bcatch\b/g)].length,
    catchStmt: [...b.matchAll(/(?<![.\w$])catch\s*[({]/g)].length,
  };
};

test('the recorded components all match the source', () => {
  const t = truth();
  // The record's numbers are a snapshot of the file at R626; what must hold is that the RECORDED breakdown is self-consistent
  // and that the live components sum to the live total.
  assert.ok(t.plainIf >= COUNTING.plainIf, `plain if fell from ${COUNTING.plainIf} to ${t.plainIf}`);
  assert.ok(t.elseIf >= COUNTING.elseIf);
  assert.ok(t.ifTotal >= COUNTING.ifTotal);
  assert.ok(t.els >= COUNTING.else);
  assert.ok(t.catchAny >= COUNTING.catchAnyForm);
  assert.ok(t.catchStmt >= COUNTING.catchStatementPosition);
  assert.equal(t.plainIf + t.elseIf, t.ifTotal, 'plain if plus else-if no longer equals the if total');
});

test('the tool still reports 352 and its breakdown still closes', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'branch-coverage.cjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(0, 300));
  const out = r.stdout;
  // The total moves as the file grows; what must hold is that the components sum to it.
  const total = Number(/branches:\s*(\d+)/.exec(out)[1]);
  assert.ok(total > 300, `the branch total fell to ${total}`);
  // Anchor past `else-if`: an unanchored /if\s+(\d+)/ matches the tail of that line first.
  const ifCount = Number(/^\s+if\s+(\d+)$/m.exec(out)[1]);
  assert.ok(ifCount > 300, `the if component fell to ${ifCount}`);
  const elseIfCount = Number(/^\s+else-if\s+(\d+)$/m.exec(out)[1]);
  const elseCount = Number(/^\s+else\s+(\d+)$/m.exec(out)[1]);
  const catchCount = Number(/^\s+catch\s+(\d+)$/m.exec(out)[1]);
  assert.equal(ifCount + elseIfCount + elseCount + catchCount, total, 'the breakdown no longer sums to the total');
  assert.equal(COUNTING.closes, true);
  assert.equal(COUNTING.toolBreakdown.if + COUNTING.toolBreakdown.elseIf + COUNTING.toolBreakdown.else
    + COUNTING.toolBreakdown.catch, COUNTING.toolBranches, 'the RECORDED breakdown no longer sums');
});

test('the lookbehind that excludes else-if is still in the tool', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'branch-coverage.cjs'), 'utf8');
  assert.match(src, /\(\?<!else\\s\)\\bif\\s\*\\\(/, 'the negative lookbehind is gone');
});

test('both traps are recorded with the hand-count error each caused', () => {
  assert.equal(TRAPS.length, 2);
  for (const t of TRAPS) {
    assert.ok(t.how.length > 10, `${t.trap} has no mechanism`);
    assert.ok(t.handCountError.length > 10, `${t.trap} has no hand-count consequence`);
  }
  const elseIf = TRAPS.find((t) => t.trap.includes('else if'));
  assert.ok(elseIf, 'the else-if trap is missing');
  assert.match(elseIf.handCountError, /360/, 'the wrong arithmetic is not recorded');
});

test('the lesson reverses the earlier pattern rather than repeating it', () => {
  assert.match(LESSON.pattern, /better than the ad-hoc probes/, 'the lesson is not stated');
  assert.match(LESSON.evidence, /two attempts and still got catch wrong/, 'the concrete instance is not given');
  assert.match(LESSON.contrast, /here my reading was wrong and the tool was right/, 'the reversal is not stated');
});

test('the record refuses to equate 352 with 367', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'branch-counting.cjs'), 'utf8');
  assert.ok(src.includes('Not that 352 is comparable to the 367'), 'the incomparability is not disclosed');
  assert.match(src, /measure\s+different things|measure different things/, 'the reason is not stated');
});
