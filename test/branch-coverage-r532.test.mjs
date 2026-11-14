// R532: the denominator. "8 of 9 mutations caught" says nothing about how much of the file is protected.
//
// WHY THIS ROUND EXISTS
//   R530 and R531 built a nine-entry mutation table and drove it to 8 caught. That number describes the TABLE. The
//   entries were chosen by hand from decisions that looked important, and nothing enumerated what was omitted. So the
//   honest statement was never "the file is 89% covered" — it was "eight of nine hand-picked decisions are protected",
//   and the denominator was missing.
//
// THE COUNT
//   367 branches in desktop/session-kernel.cjs — 322 `if`, 7 `else-if`, 6 `else`, 32 `catch`, 0 `case`.
//   Five of them contain a mutation anchor: 1.4%.
//
//   And the more useful finding is about the table's SHAPE rather than its size: five of the nine entries do not
//   anchor inside any branch at all. They mutate statements in a branch BODY —
//       cancel-approvals          resolveAllApprovals(...)          a call, not a condition
//       cancel-abort              controller.abort()                a call
//       cancel-no-running-turn    the `return {ok:false}` object   an outcome, not a condition
//       visibility-arm            idleLifecycle.onVisibilityChange  a call
//       visibility-wasvisible-default  the `: true` of a ternary   an expression
//   So the table measures "does removing this effect get noticed", which is valuable and is not the same question as
//   "is this decision's condition tested". Both numbers are now reported separately.
//
// THE BUG THAT MADE THE FIRST COUNT WRONG, IN THE OPTIMISTIC DIRECTION
//   The first run reported 306 branches and claimed eight mutations inside ONE `if (` at line 765 — an MCP auth check
//   with nothing to do with cancel. The cause: line 767 is
//       return { error: "Couldn't verify server config. Click Connect first." };
//   The blanking pass entered a string on any quote and left on any quote, so the apostrophe in `Couldn't` ended the
//   double-quoted string, the closing `"` opened a new one, and everything after line 767 was blanked — including every
//   closing brace. The branch at 765 acquired an extent running to line 2635.
//
//   That is the same family as every other defect in this thread: a detector that did not model its input, whose
//   output was believed. It reported MORE coverage than existed, which is the direction that ends the work early.
//   Fixed by tracking which character opened the string, and by re-entering code at `${` inside a template.
//
// WHAT IS NOT CLAIMED
//   Not that 1.4% is the coverage figure for anything except "an anchor lies inside a branch". A branch can be
//   touched by a mutation and still have an untested condition, and 362 branches are untouched by anything.
//   Not that the branch count is exact: ternaries are excluded because `?` also appears in optional chaining, and
//   `switch` has one `case` in this file so that category is effectively untested by this tool.
//   Not that `branchExtent` is a parser: a single-statement consequent is bounded by the next `;`, which is right for
//   the shapes here and would be wrong for a `;` inside a for-header.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The blanker is imported, not sliced out of a source file: R550 gave it a single home in tools/lexer.cjs, and the
// previous `new Function(src.slice(...))` extraction broke the moment the function moved.
import { blank } from '../tools/lexer.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'branch-coverage.cjs');
const KERNEL = path.join(ROOT, 'desktop', 'session-kernel.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('the branch count is in the hundreds, so the denominator is real', () => {
  const d = report();
  assert.ok(d.total > 300, `only ${d.total} branches found: the counter may be skipping constructs`);
  // Every kind the file actually contains must appear.
  assert.ok(d.byKind.if > 250, `if count is ${d.byKind.if}`);
  assert.ok(d.byKind.catch > 20, `catch count is ${d.byKind.catch}`);
  assert.ok(d.byKind['else-if'] > 3, `else-if count is ${d.byKind['else-if']}`);
});

test('no single branch swallows the whole file', () => {
  // The failure that produced the first wrong number: an extent running from line 765 to 2635. An extent must not
  // reach past a sane bound, or every mutation after it is counted as touching it.
  const d = report();
  const total = fs.readFileSync(KERNEL, 'utf8').split('\n').length;
  // Reported rows carry the branch line but not its end, so the check is indirect but exact for the symptom: a
  // branch claiming many distinct mutations is the tell.
  const greedy = d.rows.filter((r) => r.coveredBy.length >= 5);
  assert.deepEqual(greedy.map((r) => `L${r.line} (${r.coveredBy.length})`), [],
    'a branch claims five or more mutations: its extent probably over-reaches, which is how R532 got 306/wrong');
  assert.ok(total > 2000, 'the kernel file looks unexpectedly small');
});

test('the string-blanking failure is recorded where it happened', () => {
  // THE EXPLANATION MOVED WITH THE CODE, AND THE ASSERTION DID NOT
  //   R550 extracted blank() into tools/lexer.cjs and its doc comment went along. Reading `TOOL` then found nothing and
  //   reported "the concrete line that broke the scanner is no longer named" — true of this file, false of the
  //   repository. That is the shape of every mislocated assertion in this session: a check that cannot tell "the text
  //   moved" from "the text was deleted".
  //
  //   It now reads the file the explanation actually lives in, and asserts that the lexical layer exists at all so a
  //   future move fails with a clear message instead of a content mismatch.
  const lexer = path.join(ROOT, 'tools', 'lexer.cjs');
  assert.ok(fs.existsSync(lexer), 'tools/lexer.cjs is gone: the blanker has no single home');
  const source = fs.readFileSync(lexer, 'utf8');
  assert.match(source, /Couldn't verify/,
    'the concrete line that broke the scanner is no longer named');
  // The exact wording, checked against the file rather than remembered.
  assert.match(source, /left the string at the apostrophe/,
    'the mechanism is no longer named');
  assert.match(source, /o\s*\n?.*pened a new string|opened a new string/i,
    'the consequence is no longer explained');
});

test('the quote character is tracked, not assumed', () => {
  // A direct behavioural check on the blanking: a double-quoted string containing an apostrophe must not leak.
  //
  // This used to slice `function blank(text)` out of tools/branch-coverage.cjs and `new Function` it. R550 moved the
  // blanker into tools/lexer.cjs, so that slice returned undefined and the test failed with "blank is not defined" —
  // a test that broke because the code moved, not because the behaviour changed. Importing the real module removes
  // both the slicing (which has failed five times in this repository on brace literals) and the eval.
  const sample = 'x = "Couldn\'t stop"; if (a) { b(); }';
  const b = blank(sample);
  assert.equal(b.split('{').length, sample.split('{').length,
    'the brace after a double-quoted string with an apostrophe was not preserved');
  assert.equal(b.includes('if (a)'), true, 'code after the string was blanked');
});

test('the five anchors outside any branch are reported, not hidden', () => {
  const d = report();
  // These mutate statements rather than conditions. Reporting them as unmatched is what distinguishes "does removing
  // this effect get noticed" from "is this condition tested".
  assert.ok(d.mutationsUnmatched.length >= 4,
    `only ${d.mutationsUnmatched.length} anchors fall outside every branch: expected several`);
  for (const id of ['cancel-abort', 'cancel-approvals']) {
    assert.ok(d.mutationsUnmatched.includes(id), `${id} should be outside any branch`);
  }
});

test('the coverage figure and its meaning are both stated', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /HOW COVERAGE IS COMPUTED/,
    'the computation method is no longer described');
  assert.match(source, /not that its CONDITION is asserted|does not prove the branch's CONDITION is tested/i,
    'the distinction between touched and tested is gone');
  assert.match(source, /Ternaries are NOT counted|Ternaries are not counted/,
    'the excluded construct is not disclosed');
});
