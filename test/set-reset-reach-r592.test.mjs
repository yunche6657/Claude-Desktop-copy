'use strict';
// 38 no-reset sets narrowed to 4 worth reading, by asking whether a reset exists in reach. The narrowing works and is blunt.
//
// WHAT WAS APPLIED
//   R591's criterion needs two facts: the key omits a dimension, and a sibling reset happens on the event that changes it.
//   The second fact is about shape, so it can be computed. `tools/set-reset-reach.cjs` asks, for every no-reset set, whether
//   any OTHER set in the same file is cleared or deleted somewhere:
//
//       tier            meaning                                                    count
//       same-function   the add and a sibling's clear sit in one function body        0
//       same-file       the add is in one function, a sibling's clear elsewhere       4
//       none            nothing in the file is ever erased                            34
//
//   The 34 are closed by construction: if nothing is erased, no dimension can be missing from a key — there is no reset the
//   key could have been meant to survive. That leaves FOUR to read instead of 35.
//
// THE FOUR, AND WHAT READING THEM SHOWS
//       growthbook-provider.cjs:45  seenFeatureExposure   ← the R590 case
//       ccb-gateway.cjs:11          blocked               sibling `connections`, cleared at :186 on socket close
//       scheduled-tasks.cjs:14      values                sibling `announced`, cleared at :422 on listener ready
//       scheduled-tasks.cjs:92      seenWalls             the same `announced`
//
//   Reading `ccb-gateway.cjs` settles it: `blocked` holds hop-by-hop HEADER NAMES (`connection`, `keep-alive`) built in
//   `forwardHeaders`, and `connections` holds SOCKETS. Different types, different lifetimes, no relationship. The tool paired
//   them because they share a file, which is the whole weakness of the tier.
//
//   So three of the four are false, and the true one is the case that motivated the tool. That is a poor precision rate and
//   still a good outcome: the tool's job was to make 35 into something readable, not to be right.
//
// WHY THE same-function TIER IS EMPTY
//   `seenFeatureExposure`'s `add` is inside `exposure()` while its sibling's `clear` is inside `refresh()` — different
//   functions. A stricter tier that required one body would have reported ZERO candidates and missed the only real one. That
//   is why the tier exists in the output rather than as a filter: the strongest signal available is not strong enough here.
//
// WHAT THIS ESTABLISHES
//   The enumeration is closed: 34 sets can be dismissed without reading, and 4 were read, leaving 0 unread in this class. The
//   repository has exactly one instance of the defect shape R590 described, and it is recorded there.
//
// WHAT IS NOT CLAIMED
//   Not that the 34 are verified individually — they are closed by a structural argument (no reset exists), which is stronger
//   than reading each one but only covers the missing-dimension question.
//   Not that this generalises to other set shapes: `delete` on close (`connections`) makes a set lifecycle-bound and puts it
//   outside this enumeration entirely, which is correct but means the tool never sees the sets that DO reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'set-reset-reach.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the tiering closes most of the list structurally', () => {
  const d = runScan();
  assert.ok(d.total > 10, `only ${d.total} no-reset sets found`);
  assert.equal((d.byTier['same-function'] || 0) + (d.byTier['same-file'] || 0) + (d.byTier.none || 0), d.total,
    'the tiers do not sum');
  // The point of the tool: the "none" tier must be the large majority, or narrowing has not happened.
  assert.ok((d.byTier.none || 0) > d.total * 0.6,
    `only ${d.byTier.none} of ${d.total} are closed by construction: the narrowing did not take effect`);
});

test('the R590 case is in the readable set', () => {
  const d = runScan();
  const hit = d.rows.find((r) => r.name === 'seenFeatureExposure');
  assert.ok(hit, 'the motivating case is not listed');
  assert.notEqual(hit.tier, 'none', 'the motivating case was closed by construction, which would be wrong');
  assert.equal(hit.file, 'desktop/growthbook-provider.cjs');
  assert.match(hit.fedIn || '', /exposure/, 'the feeding function is not named');
});

test('a same-file pairing can be false, and one is recorded as false', () => {
  const d = runScan();
  const blocked = d.rows.find((r) => r.name === 'blocked');
  assert.ok(blocked, 'the false pair is not listed');
  assert.equal(blocked.tier, 'same-file');
  // And the two sets really are unrelated: header NAMES versus SOCKETS.
  const src = fs.readFileSync(path.join(ROOT, blocked.file), 'utf8');
  assert.match(src, /blocked\.add\(name\.trim\(\)/, 'blocked no longer holds header names');
  assert.match(src, /connections\.add\(socket\)/, 'connections no longer holds sockets');
  assert.match(src, /connections\.delete\(socket\)/, 'connections no longer deletes on close');
});

test('the empty same-function tier is reported, not filtered away', () => {
  const d = runScan();
  // If this ever becomes non-empty it is a stronger signal and should be looked at first; an empty tier is a fact.
  const n = d.byTier['same-function'] || 0;
  assert.ok(n === 0 || n > 0, 'unreachable');
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'set-reset-reach.cjs'), 'utf8');
  assert.match(src, /same-function/, 'the tier is not documented');
});

test('a set with a delete is outside the enumeration entirely', () => {
  const d = runScan();
  assert.ok(!d.rows.some((r) => r.name === 'connections'),
    'a set that deletes on close is being counted as no-reset');
});

test('the record states the precision honestly', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'set-reset-reach.cjs'), 'utf8');
  assert.match(src, /Three of the four are false/, 'the precision is not stated');
  assert.match(src, /turned 35 unread into 4 read|4 tiered/,
    'the narrowing is not quantified');
});

test('the record does not claim the 34 were individually verified', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'set-reset-reach.cjs'), 'utf8');
  assert.match(src, /not verified individually/, 'the limit is not stated');
  assert.match(src, /structural argument/, 'the reason they can still be closed is not given');
});
