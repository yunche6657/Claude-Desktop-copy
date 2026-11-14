// R548: measuring what the narrowed guard rule does not see, and repairing a check that could not fail.
//
// PART ONE — THE BLIND SPOT HAS A SIZE
//   R547 narrowed the rule to "the block's entire body is assertions", because the wider rule reported 14 guards and
//   most were legitimate conditionals. The price was documented but not measured. `tools/guard-blind-spots.cjs` counts
//   every `if` block in the suite and classifies its statements:
//
//       380 if-blocks examined, 0 unreadable
//         no-assert             331      <- nothing asserted; not this rule's subject
//         assert-only            23      <- what the rule reports
//         compute-then-assert    11
//         assert-then-more        6      <- the assertion always ran; cannot hide
//         empty                   4
//         call-then-assert        3
//         loop-then-assert        2
//       blind spots: 16
//
//   All 16 were read. Every one derives a value and then checks it — `enum-values` builds the member list then compares
//   it, `exec-availability` runs a command then asserts on the result, `installer-payload` stats the asar then checks
//   its size. None is the "condition false means nothing is proven" shape. So the narrow rule's cost is 16 blocks, and
//   none of them is currently a hole.
//
// PART TWO — A CHECK IN THE SUITE COULD NOT FAIL, AND THE NEW SCANNER FOUND IT
//   `test-hygiene.test.mjs` had:
//
//       if (/^\s*if \(/.test(lines[i]) && /^\s*assert\./.test(lines[i + 1])) {
//         const window = lines.slice(i, i + 4).join('\n');
//         assert.match(window, /assert\./, file + ' has a guard with no assertion nearby');
//       }
//
//   The guard condition already requires `lines[i + 1]` to start with `assert.`, and the window starts at `lines[i]`
//   and therefore contains `lines[i + 1]`. The assertion was guaranteed by the condition that reached it — a tautology
//   in the one file whose purpose is catching tautologies. It also read a single line, so it could not notice a second
//   guard two lines down.
//
//   Replacing it with a count immediately failed on six files carrying two or three guards each, which is legitimate
//   (`default-browser-name` checks three platform cases). The checkable form is a declared count per reviewed file, so
//   an added guard changes the number and the test says so — without pretending a reviewed file may only have one.
//
// WHAT IS NOT CLAIMED
//   Not that the 16 blind spots stay harmless: the classification is by shape, and a future block of the same shape
//   could be a real hole. The counts are recorded so a later round can re-measure rather than re-argue.
//   Not that `assert-then-more` is always safe — an assertion that ran and passed is not a hole, but the later work in
//   that block is unexamined.
//   Not that the declared counts are the RIGHT counts: they are today's counts, and their job is to change loudly when
//   the files do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanText } from '../tools/guard-scan.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'guard-blind-spots.cjs');

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

test('every if-block in the suite is readable, so the counts describe the whole suite', () => {
  // An unreadable block is an unknown rather than a zero, and the tool reports it separately for that reason.
  //
  // The block count dropped from 380 to 257 in R549, and the drop is the point: `guardBlock` used to take the first
  // `{` after `if (` as the body opener, so `if (x) return { a: 1 };` started a block at the OBJECT literal and every
  // line inside it was read as a statement. The paren-aware opener rejects those. A count that went UP after this
  // change would mean the phantom blocks came back.
  const d = report();
  assert.deepEqual(d.unparsed, [],
    'these blocks could not be read, so their shape is unknown: '
    + JSON.stringify(d.unparsed.slice(0, 5)));
  assert.ok(d.blocks > 200, `only ${d.blocks} if-blocks found: the scan is not covering the suite`);
  assert.ok(d.blocks < 400, `${d.blocks} blocks found: the count suggests object literals are being read as blocks again`);
});

test('the blind spot is counted, and the count is not zero', () => {
  const d = report();
  assert.ok(d.blindSpots > 0,
    'no blind spots: either the rule widened again or the classifier collapsed every shape into assert-only');
  // And the rule's own category exists, so the comparison is meaningful.
  assert.ok(d.byKind['assert-only'] > 0, 'the rule reports nothing at all');
  assert.ok(d.byKind['compute-then-assert'] > 0, 'the shape the narrowed rule cannot see is absent');
});

test('the tool classifies by statement shape rather than by file', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /function classify\(statements\)/, 'classification is gone');
  for (const kind of ['compute-then-assert', 'loop-then-assert', 'nested-if', 'assert-then-more']) {
    assert.ok(src.includes(`'${kind}'`), `the ${kind} category is gone`);
  }
  // And it must state that the list is not an error list.
  assert.match(src, /Not an error list/, 'the tool no longer says the counts are not defects');
});

test('the reviewed guard counts match the files', () => {
  // The check that replaced the tautology. A reviewed file whose guard count changed must be re-reviewed.
  //
  // Located by indexOf and sliced, not by a regex over the file text: this suite is scanned by the finder that reports
  // `readFileSync(…)` followed by a regex literal, and writing it the other way made this test a NEW risky row in its
  // own baseline — the fourth time in this session that an assertion about a scanner became input to that scanner.
  const src = fs.readFileSync(path.join(ROOT, 'test', 'test-hygiene.test.mjs'), 'utf8');
  const at = src.indexOf('const REVIEWED_GUARD_COUNTS = {');
  assert.ok(at >= 0, 'the declared counts table is gone');
  const end = src.indexOf('\n};', at);
  assert.ok(end > at, 'the declared counts table is not terminated');
  const body = src.slice(at, end);
  const declared = {};
  for (const m of body.matchAll(/'([^']+\.test\.mjs)':\s*(\d+)/g)) declared[m[1]] = Number(m[2]);
  assert.ok(Object.keys(declared).length > 10,
    `only ${Object.keys(declared).length} counts parsed: the table format changed`);

  const wrong = [];
  for (const [file, n] of Object.entries(declared)) {
    const p = path.join(ROOT, 'test', file);
    if (!fs.existsSync(p)) { wrong.push(`${file}: declared ${n}, file is missing`); continue; }
    const actual = scanText(fs.readFileSync(p, 'utf8')).found.length;
    if (actual !== n) wrong.push(`${file}: declared ${n}, actual ${actual}`);
  }
  assert.deepEqual(wrong, [], 'reviewed guard counts drifted:\n' + wrong.join('\n'));
});

test('the tautological check is gone', () => {
  // It asserted that a window starting at `lines[i]` contains `lines[i + 1]`, having already required it to.
  const src = fs.readFileSync(path.join(ROOT, 'test', 'test-hygiene.test.mjs'), 'utf8');
  assert.ok(!/has a guard with no assertion nearby/.test(src),
    'the tautological assertion message is back');
  assert.ok(!/lines\.slice\(i, i \+ 4\)\.join/.test(src),
    'the four-line window check is back');
  assert.match(src, /the reviewed guard counts no longer match the files/,
    'the replacement check does not say what it verifies');
});

test('the zero counts are documented rather than silently accepted', () => {
  // Seven reviewed files report no guard under the narrowed rule. That is the rule's cost, recorded so a reader does
  // not think the exemption is doing work it no longer does.
  const src = fs.readFileSync(path.join(ROOT, 'test', 'test-hygiene.test.mjs'), 'utf8');
  assert.match(src, /FIVE ENTRIES ARE ZERO|ARE ZERO/, 'the zero entries are not explained');
  assert.match(src, /does not describe them today/, 'the explanation does not say what a zero means');
});
