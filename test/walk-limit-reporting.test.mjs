// Every cap must announce itself. This file covers the second one.
//
// Round 210 fixed Glob's max_results cap (200 files, silently dropped). This round found a
// deeper cap: listTree stops at 20,000 entries, and Glob discarded its `truncated` flag.
//
// Measured on a workspace with 20,050 files:
//   before: glob returned 1,765 of 20,050 — no notice, and raising max_results could not help
//           because the files were never enumerated
//   after : glob returns 1,765 and says
//             … [the workspace walk hit its entry limit, so this list may be incomplete;
//                narrow the pattern to search a smaller subtree]
//
// The user-visible failure is the same shape as round 210 but worse: a search that misses
// 91% of its files still answers "no matches" with full confidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));
const { listTree } = require(path.join(ROOT, 'desktop', 'workspace-tree.cjs'));

test('listTree reports when it stopped early', () => {
  // The flag exists; this pins it so a refactor cannot quietly drop it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-flag-'));
  try {
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), '');
    const capped = listTree(dir, { maxEntries: 5 });
    assert.equal(capped.truncated, true, 'a capped walk did not report truncation');
    const full = listTree(dir, { maxEntries: 500 });
    assert.equal(full.truncated, false, 'a complete walk claimed truncation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// One big workspace serves both cap assertions: creating 20,050 files costs ~7 s, and two
// separate tests paid that twice. (Round 198: a test must not cost more than it verifies.)
test('Glob reports both caps separately on a large workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-both-'));
  try {
    for (let i = 0; i < 20050; i++) fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(6, '0') + '.txt'), '');
    const byName = Object.fromEntries(
      defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] }).map((t) => [t.name, t]),
    );
    // Unbounded max_results still cannot see past the walk limit, and must say so.
    const unbounded = String((await byName.Glob.handler({ pattern: '*.txt', max_results: 100000 })).content || '');
    assert.match(unbounded, /workspace walk was limited/,
      'a truncated walk was reported as a complete result');
    // Both caps at once: they are different problems with different advice.
    const both = String((await byName.Glob.handler({ pattern: '*.txt', max_results: 10 })).content || '');
    assert.match(both, /more matches? not shown/, 'the max_results cap is not reported');
    assert.match(both, /workspace walk was limited/, 'the walk cap is not reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('a small workspace carries no walk-limit notice', async () => {
  // The notice must not appear on ordinary results, or it becomes noise nobody reads.
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: ROOT, allowedRoots: [ROOT], execRoots: [ROOT] }).map((t) => [t.name, t]),
  );
  const content = String((await byName.Glob.handler({ pattern: 'package.json' })).content || '');
  assert.equal(/workspace walk was limited/.test(content), false,
    'a complete result claims the walk was truncated');
});
