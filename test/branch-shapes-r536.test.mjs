// R536: `(top level)` held a third of the file, and the total it was measured against was itself over-counted.
//
// WHAT R535 LEFT
//   138 of 367 branches had no owner. That bucket was not evidence of anything untested, but it was also not ranked —
//   and ranking is the whole purpose of the R534 tool.
//
// WHAT WAS IN THERE, MEASURED BEFORE CHANGING ANYTHING
//   Classifying each unowned branch by the declaration that precedes it:
//       70  in `const name = (...) => {}`
//       63  in object method shorthand `name(args) {`
//        5  in object property arrows `name: (...) =>`
//   None of those carry a `function` keyword, so R535's walk-back could not find them. The shapes were added.
//
// TWO THINGS WENT WRONG IN ADDING THEM, AND BOTH ARE THE SAME FAMILY AS EVERY OTHER DEFECT IN THIS THREAD
//   1. The method-shorthand pattern also matches control statements. `if (cond) {` is character-for-character
//      `name(args) {`. The first run produced a bucket of 40 branches attributed to a function called `if`, and 36 to
//      one called `for`. Keyword names are now rejected.
//
//   2. The brace that follows a declaration is not necessarily THAT declaration's body.
//      `const current = () => !disposed && ... ;` is a concise arrow with no braces, wrapping onto two lines. The walk
//      found the next `{` — one line away, opening a `try` in the STATEMENT AFTER it — and credited six branches to a
//      function whose body is an expression. Requiring the gap to end in `=>`, `function (...)`, or a method-shorthand
//      parameter list fixes it; `current` went from six rows to one.
//
//      My first attempt at that guard rejected any `;` in the gap, which collapsed `(top level)` from 124 to 325 —
//      because `indexOf('{')` routinely skips several complete statements, so their semicolons sit in the gap. A
//      line-count bound plus a body-shape check is what works; a semicolon is not evidence either way.
//
// AND THE TOTAL WAS WRONG
//   Eleven lines carried two rows each: `else if (x) {` matched both the `if` and the `else if` pattern, and
//   `.catch(() => {})` matched the handler pattern while being a promise method. Deduped: 367 -> 352.
//   R532's denominator was overstated by eleven for three rounds and nothing noticed, because both rows shared a line
//   and read as a duplicate report rather than a counting bug.
//
// WHAT IS NOT CLAIMED
//   Not that all 123 remaining `(top level)` branches are genuinely ownerless: a callback passed inline, an IIFE, and
//   a class body all still land there. Not that the four shapes cover every declaration form — `class`, `export
//   default`, and `let x = function()` variants are untested by this walk. Not that 352 is final: it is the count this
//   tool produces after deduplication, and the dedup itself is a pattern fix rather than a parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

test('no branch is attributed to a language keyword', () => {
  // Failure 1. `if (cond) {` is indistinguishable from `name(args) {` by pattern alone.
  const d = report();
  const keywords = ['if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else', 'return', 'typeof'];
  const bad = [...new Set(d.rows.map((r) => r.fn))].filter((fn) => keywords.includes(fn));
  assert.deepEqual(bad, [], 'these "functions" are control keywords: ' + bad.join(', '));
});

test('a concise arrow does not adopt the next statement\'s braces', () => {
  // Failure 2, on the concrete case. `current` is declared six times; the row at 644 must belong to the declaration
  // whose body actually contains it, and the concise arrow at 578 must own nothing.
  const d = report();
  const src = fs.readFileSync(KERNEL, 'utf8').split('\n');

  // R636: locate both declarations by CONTENT, not by line number. The numbers moved when later rounds edited this file, and a
  // line-pinned assertion then reports a defect in the tool when the real change was in the source.
  const conciseAt = src.findIndex((l) => /const current = \(\) =>/.test(l) && !l.includes('{'));
  assert.ok(conciseAt >= 0, 'the concise current declaration is gone, so this case no longer exists');
  const blockAt = src.findIndex((l) => /const current = \(\) => \{/.test(l));
  assert.ok(blockAt >= 0, 'the block-bodied current declaration is gone');

  // R636: the branches a function owns must lie INSIDE its body. Find where that body ends, then assert containment — a fixed
  // line number was a snapshot of an older revision and reported a tool defect that was not there.
  let depth = 0;
  let bodyEnd = -1;
  const joined = src.slice(blockAt).join('\n');
  for (let i = joined.indexOf('{'); i < joined.length; i += 1) {
    if (joined[i] === '{') depth += 1;
    else if (joined[i] === '}') { depth -= 1; if (depth === 0) { bodyEnd = blockAt + joined.slice(0, i).split('\n').length; break; } }
  }
  assert.ok(bodyEnd > blockAt, 'could not find the end of the current body');

  const currentRows = d.rows.filter((r) => r.fn === 'current').map((r) => r.line);
  assert.ok(currentRows.length >= 1, 'current owns no branch, though its body contains a catch');
  for (const line of currentRows) {
    assert.ok(line > blockAt + 1 && line <= bodyEnd,
      'current owns line ' + line + ' which is outside its body (' + (blockAt + 1) + '..' + bodyEnd + ')');
  }

  // And the concise declaration really is concise — that is what makes the case meaningful.
  assert.equal(src[conciseAt].includes('{'), false, 'the concise declaration now has a brace');
});

test('the total is deduplicated and every row has a distinct offset', () => {
  // The counting bug: eleven lines carried two rows.
  const d = report();
  // R636: 352 was a snapshot of this file at R536; the file has been edited since. Assert the relation, which is what the test
  // is actually about — a deduplicated total with distinct offsets.
  assert.ok(d.total > 300, `the deduplicated total fell to ${d.total}`);
  const offsets = d.rows.map((r) => r.offset);
  assert.equal(new Set(offsets).size, offsets.length, 'two rows share a keyword offset');
  // `else if` must no longer be counted as a plain `if`.
  assert.equal(d.byKind['if'] + d.byKind['else-if'], d.total - d.byKind.catch - d.byKind.else - (d.byKind.case || 0),
    'the kinds do not add up to the total');
});

test('else-if is not double-counted as both if and else-if', () => {
  const src = fs.readFileSync(KERNEL, 'utf8');
  const elseIfCount = (src.match(/\belse\s+if\s*\(/g) || []).length;
  const d = report();
  assert.equal(d.byKind['else-if'], elseIfCount,
    `the source has ${elseIfCount} else-if clauses but ${d.byKind['else-if']} were counted`);
});

test('a promise .catch() is not counted as a handler', () => {
  const d = report();
  const src = fs.readFileSync(KERNEL, 'utf8');
  const totalCatch = (src.match(/\bcatch\s*[({]/g) || []).length;
  const methodCatch = (src.match(/\.catch\s*\(/g) || []).length;
  assert.equal(d.byKind.catch, totalCatch - methodCatch,
    `catch handlers counted as ${d.byKind.catch}, expected ${totalCatch} minus ${methodCatch} promise methods`);
});

test('the four declaration shapes and the two failures are documented', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /70 sit in `const name = \(\.\.\.\) => \{\}`/, 'the measurement is no longer recorded');
  assert.match(source, /a bucket of 40 branches[\s\S]{0,80}attributed to a function named `if`/,
    'the keyword-collision failure is not described');
  assert.match(source, /concise arrow — no braces at all|concise body: the declaration ends/,
    'the concise-arrow failure is not described');
  assert.match(source, /367 -> 352|overstated by eleven/,
    'the over-count is not recorded');
});

test('the remaining blind spots are named', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /arrow function assigned to a const has no|concise body/,
    'the concise-body limit is gone');
  const d = report();
  const top = d.rows.filter((r) => r.fn === '(top level)').length;
  assert.ok(top > 40, `'(top level)' has only ${top} branches: the remaining blind spots may have been claimed solved`);
});
