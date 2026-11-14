// R549: 177 single-statement guard bodies, of which 84 were not blocks at all.
//
// WHAT WAS MEASURED FIRST, AND WHY IT WAS WRONG
//   `tools/empty-guards.cjs` was written to answer R548's open question: of the 331 `if` blocks that assert nothing,
//   which ones have a body of exactly one statement — the place a missing assertion would be one line long? It reported
//   177, with a bucket called `other` holding 143 of them.
//
//   143 unclassified is not a finding; it is a broken classifier. Reading them showed the statements were not
//   statements:
//
//       account-store.test.mjs:342   status: 400, ok: false, async json() { return {}; }
//       ccb-mcp-control-r378:31      contents:[{uri:r.uri,text:'old'}]
//       chunk-naming-r439:74         file: f, refs: refs.size
//
//   Those are lines INSIDE an object literal. `guardBlock` located the body by
//   `indexOf('{', indexOf('if ('))` — the first brace after `if (` — and `if (x) return { a: 1 };` has one, belonging
//   to the returned object. Every line of that literal then read as a statement of the block.
//
// THE FIX IS THE OPENER, NOT THE CLASSIFIER
//   `guardBlock` now tracks parentheses from the `if (` and takes the brace only where the paren depth has returned to
//   zero — the brace that closes the condition. Measured after the change:
//
//       380 if-blocks  ->  257   (123 object literals and template fragments were never blocks)
//        93 single-statement blocks
//       105 `other`   ->  14
//        12 call-only
//        52 exit, 15 record
//
// THE 12 `call-only` BLOCKS WERE READ, AND NONE IS A MISSING ASSERTION
//   They are setup actions whose effect is asserted later: `clearInterval(poll); clearTimeout(timer);
//   resolve(found.request);` in three approval tests, `fs.writeFileSync(path.join(home, '.claude.json'), …)` in three
//   store tests, `res.writeHead(302, …); res.end();` in the redirect test, and one `process.stdout.write` that exists
//   to prove a warning does not corrupt the frame stream. Each is followed by assertions on the resulting state.
//
// WHAT IS NOT CLAIMED
//   Not that the remaining 14 `other` blocks are uninteresting — they were not read, and the classifier's `other` is a
//   residual rather than a category. Not that `exit` (52) and `record` (15) are harmless: `exit` is idiomatic in a
//   guard clause and `record` hands the proof to a later `deepEqual`, but neither was checked individually. Not that the
//   block count is stable — it is what the current lexer sees, and R547/R549 both changed what that is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardBlock } from '../tools/guard-scan.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'empty-guards.cjs');

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

test('a brace belonging to a returned object literal does not open a block', () => {
  // The exact shape that produced 105 phantom statements.
  const line = 'if (x) return { a: 1, b: 2 };';
  assert.equal(guardBlock([line], 0), null,
    'an object literal after a blockless if is still being read as the body');
});

test('a brace after a nested call in the condition still opens the block correctly', () => {
  // The condition's own `)` inside a call must not be mistaken for the end of the condition.
  const lines = [
    "if (fs.existsSync(path.join(src, 'FileReadTool'))) {",
    '  assert.ok(true);',
    '}',
  ];
  const b = guardBlock(lines, 0);
  assert.ok(b, 'the block was not found');
  assert.equal(b.to, 2, 'the block extent is wrong');
});

test('the phantom single-statement blocks are gone', () => {
  const d = report();
  assert.ok(d.unreadable === undefined || d.unparsed.length === 0, 'an if-block became unreadable');
  assert.ok(d.singleStatementBlocks < 120,
    `${d.singleStatementBlocks} single-statement blocks: object literals are being read as bodies again`);
  // `other` was 143 before the fix and 105 after the statement-level filter; the opener fix took it to 14.
  assert.ok((d.byKind.other || 0) < 40,
    `${d.byKind.other} unclassified: the openers are wrong, not the classifier`);
});

test('the call-only bucket is small enough to have been read, and was', () => {
  const d = report();
  const callOnly = d.byKind['call-only'] || 0;
  assert.ok(callOnly > 0, 'the call-only bucket vanished: the classifier collapsed');
  assert.ok(callOnly < 25, `call-only grew to ${callOnly}: re-read it rather than assuming`);
  const doc = fs.readFileSync(TOOL, 'utf8');
  assert.match(doc, /THE BUCKET WORTH READING/, 'the tool no longer marks the bucket as the one to read');
});

test('the opener fix is recorded with its measurement', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'guard-scan.cjs'), 'utf8');
  assert.match(src, /105 PHANTOM BLOCKS|phantom blocks/i, 'the phantom-block finding is not recorded');
  assert.match(src, /paren === 0/, 'the paren-depth condition that identifies the body brace is gone');
});

test('the classification now recognises exits and multi-call lines', () => {
  // `exit` went 6 -> 52 when the classifier learned to split `a(); return;` on one line.
  const d = report();
  assert.ok((d.byKind.exit || 0) > 20,
    `only ${d.byKind.exit} exits classified: one-line multi-statement bodies are going to other`);
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /const parts = statements\[0\]\.split/, 'the top-level statement split is gone');
});
