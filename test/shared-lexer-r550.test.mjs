// R550: the blanker existed twice, and the copy that lacked a layer made one file permanently unscannable.
//
// WHAT THE DUPLICATE COST
//   `tools/branch-coverage.cjs` and `tools/empty-block-scan.cjs` each carried an 81-line `blank()` with the same
//   signature and purpose. Measured: 0.87 similarity, eight diff hunks, and the differences were the layers added in
//   later rounds — the quote character, the regex state, the template-literal depth.
//
//   `branch-coverage.cjs`'s copy gained template depth tracking; the other did not. Its lexer therefore lost track
//   inside template literals, reported `tools/branch-coverage.cjs` as brace-unbalanced (`balance: 3`), and dropped the
//   file as `unparsed`. So that file has been OUTSIDE `empty-block-scan`'s coverage since the layer was added, and the
//   only trace was an entry in a list nobody read.
//
//   After unifying them: `unparsed` fell from 34 files to 0.
//
// THE RISE FROM 0 TO 1 EMPTY BLOCK IS COVERAGE, NOT A REGRESSION
//   `empty-block-scan` now reports exactly one empty block, `desktop/session-kernel.cjs:2474`:
//
//       if (wasVisible && !visible) {
//         // The lifecycle owns transition timestamps and the configured timeout.
//       }
//
//   R529 judged it correct — `idleLifecycle.onVisibilityChange` at line 2481 does the work and the comment says where.
//   It was always there; the scanner simply could not reach a file whose lexing had failed.
//
// THE SECOND FINDING, FOUND BY THE FIRST
//   `tools/guard-scan.cjs` had its own imbalance (`balance: 1`) from `return /^\s*\{/.test(...)`. A regex literal after
//   `return` is not recognised by the shared opener heuristic — the token before the slash is `n` of `return`, which is
//   not in the operator set — so the escaped `\{` counted as a real brace. Replaced with `startsWith('{')`, which no
//   brace scanner can miscount.
//
// WHAT IS NOT CLAIMED
//   Not that `tools/lexer.cjs` is a parser. A regex literal whose body contains an unbalanced `(` can still mislead
//   the opener heuristic, and `a / b` is indistinguishable from a regex by any local rule; both scanners disclose this
//   by reporting an unparseable file rather than guessing.
//   Not that `duplicate-decisions.cjs` found every duplicate: it compares same-named functions only, so two differently
//   named copies of one rule are invisible to it. Its output is a ranked list of places a change must be made twice,
//   not an inventory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blank } from '../tools/lexer.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEXER = path.join(ROOT, 'tools', 'lexer.cjs');

test('there is one blanker, and both scanners import it', () => {
  const consumers = ['tools/branch-coverage.cjs', 'tools/empty-block-scan.cjs'];
  for (const rel of consumers) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /require\('\.\/lexer\.cjs'\)/, `${rel} does not import the shared lexer`);
    assert.ok(!/^function blank\(/m.test(text), `${rel} still defines its own blank()`);
  }
  assert.ok(fs.existsSync(LEXER), 'tools/lexer.cjs is missing');
});

test('each lexer layer still does its job', () => {
  // The four layers, each added in response to a measured defect. A regression in any of them re-breaks a scanner.
  const cases = [
    ['apostrophe inside a double-quoted string',
      'x = "Couldn\'t stop"; if (a) { b(); }', ['if (a)', '{ b(); }']],
    ['regex quantifier braces',
      'const re = /a{2,3}/; const n = 1;', ['const n = 1;']],
    ['template re-enters code at ${',
      'const s = `a${x}b`; const t = 2;', ['const t = 2;']],
    ['quote inside a regex literal',
      'assert.match(t, /T[a"b]+/); tail();', ['tail();']],
  ];
  for (const [name, source, mustKeep] of cases) {
    const out = blank(source);
    assert.equal(out.length, source.length, `${name}: blanking changed the length`);
    for (const keep of mustKeep) {
      assert.ok(out.includes(keep), `${name}: ${JSON.stringify(keep)} was blanked away`);
    }
  }
});

test('blanking preserves brace balance on the files that were previously unscannable', () => {
  // `branch-coverage.cjs` reported balance 3 before the unification. Every consumer needs balance 0 to count blocks.
  for (const rel of ['tools/branch-coverage.cjs', 'tools/empty-block-scan.cjs', 'tools/lexer.cjs',
    'tools/guard-scan.cjs', 'tools/empty-guards.cjs', 'desktop/session-kernel.cjs']) {
    const b = blank(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    let depth = 0;
    for (const ch of b) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; }
    assert.equal(depth, 0, `${rel} does not balance after blanking: ${depth}`);
  }
});

test('the empty-block scan now reaches every file', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'empty-block-scan.cjs'), '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, 'the scanner failed');
  const d = JSON.parse(r.stdout);
  assert.equal(d.unparsed.length, 0,
    'files are outside the scan, so their empty blocks are unknown: ' + JSON.stringify(d.unparsed.slice(0, 5)));
  // And the one empty block it does report is the one already judged correct.
  const empties = d.results.filter((x) => x.kind === 'empty-block');
  assert.equal(empties.length, 1, `expected the one known empty block, found ${empties.length}`);
  assert.equal(empties[0].file, 'desktop/session-kernel.cjs');
  const sourceLine = fs.readFileSync(path.join(ROOT, empties[0].file), 'utf8').split(/\r?\n/)[empties[0].line - 1];
  assert.match(sourceLine || '', /if\s*\(wasVisible\s*&&\s*!visible\)\s*\{/,
    'the known empty block changed identity: re-judge it');
});

test('a duplicate detector exists and ranks by what a change would have to be made twice', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'duplicate-decisions.cjs'), '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, 'the duplicate detector failed:\n' + (r.stderr || '').slice(0, 600));
  const d = JSON.parse(r.stdout);
  assert.ok(d.functions > 1000, `only ${d.functions} functions found: the scan is not covering the tree`);
  assert.ok(d.groups.length > 0, 'no duplicates found at all, which cannot be right');
  // THE PAIR THAT CAUSED THIS ROUND IS NOW GONE, AND THAT IS THE POINT
  //   `blank` used to be the top entry at 0.87. Unifying it removed the duplication, so asserting that the detector
  //   still FINDS it would be asserting that the fix did not work. What the detector must keep doing is finding the
  //   other pairs — several of which are still real (`readtree`, `walk`, `schemafields`).
  const blankPair = d.groups.find((g) => g.name === 'blank');
  assert.equal(blankPair, undefined,
    'blank() is duplicated again: tools/lexer.cjs was supposed to be its single home');
  assert.ok(d.groups.length > 10,
    `only ${d.groups.length} duplicate groups: the detector stopped finding the remaining ones`);
  // And the tool must say it is not a refactor list.
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'duplicate-decisions.cjs'), 'utf8');
  assert.match(src, /Not a refactor list/, 'the tool no longer says the list is not a refactor order');
});

test('the regex-after-return case is gone from the guard scanner', () => {
  // `return /^\s*\{/` counted its escaped brace. A string literal cannot be miscounted that way.
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'guard-scan.cjs'), 'utf8');
  assert.ok(!/return \/\^\\s\*\\\{/.test(src), 'the regex-after-return is back in guard-scan.cjs');
  assert.match(src, /startsWith\('\{'\)/, 'the string form of the body-opener test is gone');
});
