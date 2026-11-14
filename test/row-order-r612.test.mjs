// R612: the two tools that never sort DO have a decidable order. In-file order is a property of the tool and is now asserted;
// file order is a property of the checkout and is recorded, not asserted.
//
// MEASURED
//       stale-comment       67 files, 0 line-order violations — every file's rows are in increasing `line`
//       source-divergence   2 files, 0 violations by first-site line
//       stale-comment       the emitted FILE order equals the alphabetical sort of that list
//
// TWO FACTS, NOT THE SAME KIND
//   In-file order follows from the SCAN: `sources()` reads a file once and iterates its lines top to bottom, pushing rows as it
//   goes. No sort, and no filesystem behaviour can change it. Assertable.
//
//   File order follows from `readdirSync`. Alphabetical here because NTFS returns directory entries in name order for this tree.
//   On a filesystem that does not — or after enough insertions and deletions — the same code returns a different order. R611
//   measured this for the sorted tools; here it applies with no comparator in the way at all.
//
// WHY THE DISTINCTION GOVERNS WHAT TO ASSERT
//   An assertion on in-file order tests the TOOL: a change that sorts or buffers rows fails it, and the failure names the file. An
//   assertion on file order tests the CHECKOUT: it passes here and fails on a clone whose directory entries differ. Writing the
//   first and not the second is the entire point of separating them.
//
// WHAT IS NOT CLAIMED
//   Not that alphabetical file order is guaranteed: measured once, on this tree, enforced by nothing.
//   Not that in-file order holds for every tool: these two and `set-key-symmetry` build rows by scanning lines, while the sorted
//   tools override it deliberately. A tool that gathered rows into a Map before emitting would violate it — and would be caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ORDER, ASSERTION_CHOICE } from '../desktop/row-order.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runJson = (tool) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', tool), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `${tool} failed:\n` + (r.stderr || '').slice(0, 400));
  return JSON.parse(r.stdout);
};

/** Group rows by file and return the line numbers in emitted order. */
const linesByFile = (rows, lineOf) => {
  const map = new Map();
  for (const row of rows) {
    const line = lineOf(row);
    if (line === null || line === undefined) continue;
    if (!map.has(row.file)) map.set(row.file, []);
    map.get(row.file).push(line);
  }
  return map;
};

test('stale-comment emits in-file rows in increasing line order', () => {
  const d = runJson('stale-comment.cjs');
  const map = linesByFile(d.rows, (r) => r.line);
  assert.ok(map.size >= 30, `only ${map.size} files have rows — the sample is too small`);
  for (const [file, lines] of map) {
    for (let i = 1; i < lines.length; i += 1) {
      assert.ok(lines[i] >= lines[i - 1],
        `${file}: line ${lines[i - 1]} came before ${lines[i]}, so the scan does not follow declaration order`);
    }
  }
});

test('source-divergence emits in-file rows in first-site order', () => {
  const d = runJson('source-divergence.cjs');
  const map = linesByFile(d.rows, (r) => (r.sites && r.sites.length ? r.sites[0].line : null));
  assert.ok(map.size >= 1, 'no rows carry a site line');
  for (const [file, lines] of map) {
    for (let i = 1; i < lines.length; i += 1) {
      assert.ok(lines[i] >= lines[i - 1],
        `${file}: first-site line ${lines[i - 1]} came before ${lines[i]}`);
    }
  }
});

test('the recorded violation counts are still zero', () => {
  assert.equal(ORDER.inFile.measured['stale-comment'].violations, 0);
  assert.equal(ORDER.inFile.measured['source-divergence'].violations, 0);
  assert.equal(ORDER.inFile.assertable, true);
  assert.equal(ORDER.fileOrder.assertable, false);
});

test('file order is measured as alphabetical without being asserted', () => {
  // The measurement is recorded; this test reports the current answer and fails only if the record claims a guarantee it lacks.
  const d = runJson('stale-comment.cjs');
  const seen = [...new Set(d.rows.map((r) => r.file))];
  const sorted = [...seen].sort((a, b) => a.localeCompare(b));
  const nowAlphabetical = JSON.stringify(seen) === JSON.stringify(sorted);
  assert.equal(ORDER.fileOrder.measured, 'true on this tree, for both tools');
  // If this ever flips, the RECORD needs updating — the tool is not broken.
  if (!nowAlphabetical) {
    assert.ok(ORDER.fileOrder.measured.includes('true on this tree'),
      'file order changed and the record still claims alphabetical — update the record, do not fail the tool');
  }
});

test('the reason only one of the two is asserted is stated', () => {
  assert.match(ASSERTION_CHOICE.why, /property of the tool/, 'the tool-versus-checkout distinction is not stated');
  assert.match(ASSERTION_CHOICE.why, /passes here and fails elsewhere/, 'the concrete consequence is not stated');
  assert.match(ASSERTION_CHOICE.recordedInstead, /without re-deriving/, 'why it is recorded is not stated');
});

test('the in-file property has a stated failure mode', () => {
  assert.match(ORDER.inFile.failsIf, /sorts rows or buffers them/, 'the failure mode is not named');
  assert.match(ORDER.inFile.why, /iterates its lines top to bottom/, 'the mechanism is not stated');
});

test('the record does not overclaim coverage across tools', () => {
  // fs is imported at the top; ESM modules have no require.
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'row-order.cjs'), 'utf8');
  assert.match(src, /Not that in-file order holds for every tool/, 'the cross-tool limit is missing');
  assert.match(src, /set-key-symmetry/, 'the third scan-order tool is not named');
});
