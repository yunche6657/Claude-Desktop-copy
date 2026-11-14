// R565: how often does a text search return prose where it expected evidence?
//
// THE FAILURE THAT PROMPTED THIS
//   R564 asserted "the gate test does not assert shouldDefer" with a whole-file search — and failed, because
//   `mcp-tool-gate-r504.test.mjs:5` carries the comment "R501 proposed `shouldDefer: true`; the data refuted it". A
//   header explaining what was PROPOSED and what was REFUTED is the opposite of a claim, and a regex cannot tell them
//   apart.
//
//   That is a hazard for several scanners in this repository, not a one-off: each searches file text for a term and
//   trusts the hit.
//
// MEASURED, AND MEASURED WRONG FIRST
//   The first version counted an "assertion line" only when it STARTED with `assert.`. `preview-host.test.mjs` writes
//   its tests as long single lines —
//
//       const e=readEnvironment();try{await e.host.createPreview(…);assert.equal(…)
//
//   — and has 15 real assertions, none of which starts a line. Under the first rule it scored ZERO assertions, so every
//   term those assertions use was counted as "prose only", and it topped the list at 86. The bias was systematic and in
//   the optimistic direction: files that write compressed tests looked like the worst offenders, which is the opposite
//   of the truth.
//
//   After the fix — "the line's code contains `assert.` anywhere" — the totals barely moved (46262 -> 45857) but the
//   ranking changed: `preview-host` left the top, and the top is now `test-hygiene.test.mjs`, which is a file ABOUT
//   assertions and therefore has the widest prose vocabulary of any test in the repository. That is the expected shape.
//
//   Identifier-like terms only (camelCase, dotted, ALL_CAPS, digits): 6568 occurrences across 511 files.
//
// VALIDATED AGAINST THE CASE THAT MOTIVATED IT
//       --term shouldDefer     5 files mention it, 3 carry it in prose only
//       --term contractCount   3 files mention it, 0 in prose only
//
//   The first matches R564's manual finding exactly; the second shows the tool can say "no" — a scanner that always
//   finds something would be worthless.
//
// WHAT IS NOT CLAIMED
//   Not that prose-only terms are defects: a comment SHOULD say things the assertions do not — that is what explanation
//   is for. What is sized is the surface on which a text search returns prose instead of evidence.
//   Not that the term extraction is complete: it takes `[A-Za-z_$][\w$]{4,}`, so a three-letter identifier is invisible
//   and a hyphenated CLI flag is split into pieces.
//   Not that "the line's code contains assert." is exact: `assert.` inside a string literal on an asserting line would
//   also count, and a comment ending with `// assert.x` is stripped before the test — both are edge cases the tool
//   does not resolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'prose-vs-assertions.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

test('the tool reports a surface size, not a defect list', () => {
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);
  assert.ok(d.files > 500, `only ${d.files} test files scanned`);
  assert.ok(d.totalProseOnly > 1000,
    `only ${d.totalProseOnly} prose-only terms: the scan is not reading comments`);
  for (const row of d.rows) {
    assert.ok(row.count > 0, 'a reported file has no prose-only terms');
    assert.equal(row.count, row.proseOnly.length, 'the count does not match the list');
  }
});

test('a term that is genuinely asserted is not reported as prose-only', () => {
  // The control: a scanner that reports everything is worthless.
  const r = run(['--term', 'contractCount', '--json']);
  assert.equal(r.status, 0);
  const d = JSON.parse(r.stdout);
  assert.ok(d.rows.length > 0, 'contractCount is not found in any test file');
  assert.equal(d.rows.filter((x) => x.misleading).length, 0,
    'contractCount is asserted in tool-absence tests, so it must not be prose-only anywhere');
});

test('the term that motivated the round is reported as prose-only exactly where R564 found it', () => {
  const r = run(['--term', 'shouldDefer', '--json']);
  assert.equal(r.status, 0);
  const d = JSON.parse(r.stdout);
  const proseOnly = d.rows.filter((x) => x.misleading).map((x) => x.file);
  assert.ok(proseOnly.includes('mcp-tool-gate-r504.test.mjs'),
    'the file whose comment caused R564s failed assertion is not reported');
  // And the file that DOES assert it is not reported.
  assert.ok(!proseOnly.includes('deferred-tools-r501.test.mjs'),
    'deferred-tools asserts shouldDefer, so it must not be counted as prose-only');
});

test('an assertion in the middle of a long line still counts as an assertion', () => {
  // The bug that put preview-host at the top of the first ranking.
  const src = fs.readFileSync(path.join(ROOT, 'test', 'preview-host.test.mjs'), 'utf8');
  const midLineAssertions = src.split('\n').filter((l) => /\bassert\./.test(l) && !/^\s*assert\./.test(l));
  assert.ok(midLineAssertions.length > 5,
    'preview-host no longer has mid-line assertions, so this test cannot demonstrate the fix');
  // And the tool must not report it as the worst offender.
  const r = run(['--json']);
  const d = JSON.parse(r.stdout);
  d.rows.sort((a, b) => b.count - a.count);
  assert.notEqual(d.rows[0].file, 'preview-host.test.mjs',
    'preview-host is still ranked worst, which means mid-line assertions are still being ignored');
});

test('comments are stripped before the assertion test', () => {
  // A line whose only `assert.` is inside a trailing comment must not count as asserting.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /lineComment/, 'trailing comments are no longer stripped');
  assert.match(src, /inBlock/, 'block comments are no longer tracked');
});

test('the tool states that prose-only terms are not defects', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Not a defect list/, 'the output no longer says the measure is not a defect count');
});
