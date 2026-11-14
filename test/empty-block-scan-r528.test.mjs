// R528: a scanner for the shape that hid R527 — and the finding that there is only one such shape left, already
// fixed.
//
// WHAT R527 LEFT OPEN
//   `desktop/session-kernel.cjs` contained
//       if (backend && keepHeldInput) {
//         /* MUTATED: held inputs are no longer handed back before the turn is torn down */
//       }
//   A branch whose entire body was a comment saying the body had been removed. Nothing failed, so it survived until a
//   test that had been failing for many rounds was finally read. R527 closed with the obvious question: how many more?
//
// THE THREE SHAPES, AND WHY ONLY ONE SURVIVED CONTACT WITH THE DATA
//   marker       a comment containing MUTATED / MUTATION / "no longer …" — 135 found, nearly all legitimate: prose
//                about mutation, the mutate tool itself, and a proof script quoting the marker it searches for.
//   empty-block  an `if`/`else`/`while`/`for` whose body holds only comments — 50 found at first, and ALL 50 were
//                object literals: `if (!x) return {`, `for (const [k,v] of Object.entries(m || {})`. After excluding
//                expression context, zero remain.
//   empty-catch  a `catch {}` with no statements — 198 found, and every one sampled carries a comment saying why it is
//                safe ("try the next candidate", "no overlay -> no claim", "a disappearing window must not affect
//                preference updates"). That is the correct way to write it.
//
// THE ANSWER TO R527'S QUESTION
//   `MARKER INSIDE AN EMPTY BLOCK: 0`. The specific arrangement — a comment about removal sitting where a body
//   belongs — does not exist anywhere in desktop/, tools/ or test/ now. R527 was the only one.
//
// WHAT WENT WRONG ALONG THE WAY, TWICE, IN THE SAME WAY
//   First the blanking pass did not recognise regex literals, so `/a{2,3}/` desynchronised the brace counter and 149
//   of 1490 files were silently dropped as unparsed. Then the block finder ignored expression context, so object
//   literals were reported as blocks. Both are the failure this repo keeps producing: a detector that does not
//   describe its input, whose output is then believed. Both were caught by looking at the reported rows rather than
//   the counts — 50 "empty blocks" that all read `return {` is not 50 findings, it is one classifier bug.
//
// WHAT IS NOT CLAIMED
//   Not that the code has no emptied blocks: 31 files could not be brace-parsed (nested template literals defeat the
//   counter) and are reported as unparsed rather than assumed clean. Not that the 135 markers are all benign — they
//   were classified by location, not read one by one. Not that an empty catch is always fine: the ones sampled had
//   explanatory comments, and a future one without a comment would be worth a look, but nothing enforces that.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'empty-block-scan.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the scanner failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('no marker sits inside an empty block', () => {
  const d = report();
  const residue = d.results.filter((r) => r.kind === 'marker' && r.inEmptyBlock);
  assert.deepEqual(residue.map((r) => `${r.file}:${r.line}`), [],
    'a comment describing a removed body is sitting where the body belongs — the R527 shape is back');
});

test('the only empty block is the one already judged correct', () => {
  const d = report();
  // THE COUNT WENT 0 -> 1 IN R550, AND THE RISE IS COVERAGE, NOT A REGRESSION
  //   The two scanners each carried their own copy of the blanker, and `tools/branch-coverage.cjs` added a
  //   template-literal layer that `tools/empty-block-scan.cjs` never got. That scanner therefore lost track inside
  //   template literals, reported `branch-coverage.cjs` as brace-unbalanced, and dropped it as `unparsed` — so this
  //   file was never scanned at all. R550 unified them into `tools/lexer.cjs` and `unparsed` fell to 0, which is why a
  //   finding that was always there now appears.
  //
  //   It is `desktop/session-kernel.cjs:2474`, and R529 judged it correct: the `if` body holds only a comment because
  //   `idleLifecycle.onVisibilityChange` at line 2481 does the work, and the comment says where the work lives.
  const blocks = d.results.filter((r) => r.kind === 'empty-block');
  assert.equal(blocks.length, 1,
    `empty-block is ${blocks.length}: either a new emptied body appeared or the object-literal exclusion broke`);
  assert.equal(blocks[0].file, 'desktop/session-kernel.cjs', 'the known empty block is no longer the one reported');
  const sourceLine = fs.readFileSync(path.join(ROOT, blocks[0].file), 'utf8').split(/\r?\n/)[blocks[0].line - 1];
  assert.match(sourceLine || '', /if\s*\(wasVisible\s*&&\s*!visible\)\s*\{/,
    'the known visibility block changed identity: re-judge the finding');
  assert.equal(d.byKind['empty-else'] || 0, 0, 'an empty else appeared');
});

test('no file is dropped as unparsed, so the scan covers the whole tree', () => {
  // This is what the lexer unification bought: before R550, `tools/branch-coverage.cjs` and 33 other files were
  // silently outside the scan. A file that cannot be scanned is not covered by the scan.
  const d = report();
  assert.equal(d.unparsed.length, 0,
    'these files are outside the scan, so their empty blocks are unknown: '
    + JSON.stringify(d.unparsed.slice(0, 6)));
});

test('empty catches exist and each sampled one explains itself', () => {
  const d = report();
  assert.ok((d.byKind['empty-catch'] || 0) > 100,
    'suspiciously few empty catches: the detector may have stopped matching');
  // Every reported catch should carry a comment; that is what makes the pattern acceptable.
  const bare = d.results.filter((r) => r.kind === 'empty-catch' && (!r.comments || r.comments.length === 0));
  assert.deepEqual(bare.map((r) => `${r.file}:${r.line}`), [],
    'an empty catch has no explanatory comment: that is a swallowed failure, not a deliberate one');
});

test('the unparsed count is reported rather than hidden', () => {
  const d = report();
  assert.ok(Array.isArray(d.unparsed), 'unparsed files are no longer reported');
  assert.ok(d.unparsed.length < 60,
    `${d.unparsed.length} files could not be parsed: the brace counter has regressed`);
  // Each unparsed entry must carry the imbalance that caused it, so a reader can localise it.
  for (const u of d.unparsed) {
    assert.equal(typeof u.balance, 'number', `${u.file} has no balance figure`);
    assert.ok(u.balance !== 0, `${u.file} is listed as unparsed with a zero balance`);
  }
});

test('the two classifier bugs are recorded, not erased', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /149 of 1490 files were silently dropped as `unparsed`/,
    'the regex-literal failure is no longer documented');
  assert.match(source, /ALL 50 of the first run's/, 'the object-literal failure is no longer documented');
  assert.match(source, /if \(!x\) return \{/, 'the concrete object-literal shape is no longer named');
  assert.match(source, /a detector that does not\s*\*?\s*describe its input, whose output is then believed/i,
    'the lesson is not stated');
});

test('the scanner skips build output and vendored code', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /startsWith\('dist-'\)/, 'build directories are no longer skipped');
  assert.match(source, /=== 'node_modules'/, 'node_modules is no longer skipped');
  // And it must actually have scanned our own directories.
  const d = report();
  const files = new Set(d.results.map((r) => r.file.split('/')[0]));
  for (const dir of ['desktop', 'tools', 'test']) {
    assert.ok(files.has(dir), `no finding from ${dir}: the scan may not be reaching it`);
  }
});
