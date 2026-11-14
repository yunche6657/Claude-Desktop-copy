'use strict';
// Every self-pruning set in this repository deletes with the expression it added. The leak shape is absent, not merely rare.
//
// THE SHAPE THIS LOOKED FOR
//   `connections.add(socket)` then `connections.delete(socket)` cancels. `connections.add(socket)` then
//   `connections.delete(socket.id)` NEVER removes anything: the set grows for the process lifetime while carrying a delete
//   that makes it look maintained, and nothing reports it.
//
//   It is invisible to both earlier tools by construction. `set-lifetimes.cjs` enumerates sets with only `has`+`add` — a set
//   that deletes is excluded. `set-reset-reach.cjs` asks whether a reset is in reach of a NO-RESET set — same exclusion. So
//   the entire population of sets that DO clean up was never examined, and that is precisely where a leak lives.
//
// MEASURED
//       all `new Set(` in desktop/ and tools/        273
//       with at least one delete                      16
//       whose delete argument matches the add           16
//       mismatched                                       0
//       with a delete but no add in the same file        0
//
//   The sixteen are listener registries (`fn`, `callback`, `listener`), connection/subscription trackers (`socket`, `child`,
//   `cancel`), and identity-keyed maps (`ownerId`, `node.nodeId`, `task.id`, `name`, `sourceToken`). Every one of them
//   removes exactly what it stored.
//
// WHY A ZERO HERE IS STRONGER THAN THE ZEROS IN R579 AND R583
//   Those rounds reported a gap that turned out empty, and the emptiness was of an ABSENCE — nothing existed to find. This
//   zero is of a COMPARISON: sixteen pairs were compared and agreed. A comparison that could have failed and did not is
//   evidence; an absence that could not have been seen either way is only a boundary.
//
//   The distinction matters for what a reader should do next. R579's zero closed a question: no import-graph tool is needed.
//   This zero says the mechanism is sound HERE and leaves the question of whether the check should be permanent.
//
// THE RESIDUAL COVERAGE GAP
//   The comparison is TEXTUAL. `add(x)` and `delete(y)` where `y` somehow denotes `x` would be reported as a mismatch — a
//   false positive, not a miss. The direction of error is safe. What it cannot see at all is a set populated in one module and
//   pruned in another: `missingAdd` counts zero today, which means no such set exists, not that the tool would handle one.
//
// WHAT IS NOT CLAIMED
//   Not that 16 is all the self-pruning collections: only `new Set(` is examined, so a Map's `.delete` or an array splice is
//   outside it. `preview-host.cjs` keys by `node.nodeId`, which is a Map-shaped usage that happens to use a Set.
//   Not that the agreeing keys are free of every defect — a set can prune correctly and still deduplicate across a dimension
//   it should not, which is R590's finding and a different question.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'set-key-symmetry.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('every self-pruning set deletes what it added', () => {
  const d = runScan();
  assert.ok(d.sets >= 10, `only ${d.sets} sets with a delete: the population is too small to conclude anything`);
  assert.equal(d.mismatched, 0, `mismatched keys: ${d.rows.filter((r) => !r.agrees && !r.missingAdd).map((r) => `${r.file}:${r.name}`).join(', ')}`);
  assert.equal(d.agreeing + d.mismatched + d.missingAdd, d.sets, 'the categories do not sum');
});

test('the scan actually compares, so a zero is evidence', () => {
  // A tool that found nothing because it compares nothing would also print zero. Prove it compares by checking that every
  // row carries both arguments.
  const d = runScan();
  for (const r of d.rows) {
    assert.ok(r.delKey && r.delKey.length > 0, `${r.name} has no delete argument recorded`);
    if (!r.missingAdd) assert.ok(r.addKey && r.addKey.length > 0, `${r.name} has no add argument recorded`);
  }
  const withBoth = d.rows.filter((r) => r.addKey && r.delKey);
  assert.ok(withBoth.length > 10, `only ${withBoth.length} rows have both arguments: the comparison is not happening`);
});

test('the known listener sets are among the agreeing rows', () => {
  const d = runScan();
  const listeners = d.rows.filter((r) => r.name === 'listeners');
  assert.ok(listeners.length >= 5, `only ${listeners.length} listener registries found`);
  for (const r of listeners) assert.equal(r.agrees, true, `(${r.file}) listeners no longer agree`);
});

test('a cleanup handler is identified where the delete sits in one', () => {
  const d = runScan();
  const conn = d.rows.find((r) => r.name === 'connections' && r.file === 'desktop/ccb-gateway.cjs');
  assert.ok(conn, 'the socket set is no longer found');
  assert.equal(conn.deleteInCleanup, true, 'the socket close handler is no longer recognised as cleanup');
  // And it deletes the socket it added, not an id.
  assert.equal(conn.addKey, conn.delKey);
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'ccb-gateway.cjs'), 'utf8');
  assert.match(src, /connections\.add\(socket\)/);
  assert.match(src, /connections\.delete\(socket\)/);
});

test('the scan does not claim to cover collections other than Set', () => {
  const d = runScan();
  // preview-host keys by node.nodeId; it is a Set, so it is in scope, but a Map would not be.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(src.indexOf('is only') >= 0 && src.indexOf('new Set(') >= 0, 'the scope limit is not stated');
  assert.match(src, /Map's `\.delete`|array splice/, 'the excluded shapes are not named');
});

test('the record says this zero is a comparison rather than an absence', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(src.indexOf('COMPARISON') >= 0, 'the kind of zero is not stated');
  assert.ok(src.indexOf('ABSENCE') >= 0, 'the contrast with the earlier zeros is missing');
});
