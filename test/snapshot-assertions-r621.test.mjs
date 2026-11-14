// R621: the hunt for snapshot assertions found the records consistent — and caught TWO false alarms of my own making.
//
// WHAT WAS LOOKED FOR
//   R620 proposed finding `assert.equal(<computed>, <literal>)` sites whose literal should have been a relation. Measured: 447
//   sites; the four that count files all use SYNTHETIC data (`diff.files.length === 400` on a fabricated diff), so none moves with
//   the repository. The proposed class of defect does not exist at scale.
//
// WHAT WAS FOUND INSTEAD — TWICE
//       set-lifetimes population   tool=41   record=null  **DRIFT**
//       map-key-reach maps         tool=202  record=6     **DRIFT**
//
//   Both were the pattern, not the data. `exposure-set-lifetimes.SETS` is an array of THREE — the 41 belongs to
//   `set-lifetimes.cjs`, a different object. And `unasserted-fields.counts2` is `unstableDisagree` (6), not the map count. Read
//   correctly, four pairs all agree:
//
//       unasserted-fields.counts2 = 6    tool unstableDisagree  = 6    MATCH
//       unasserted-fields.counts  = 7    tool unstableSet rows  = 7    MATCH
//       rescan-after-mask.after   = 2    tool candidates        = 2    MATCH
//       sort-census map ties      = 31   measured ties          = 31   MATCH
//
// WHY THIS IS THE ROUND'S REAL RESULT
//   A pattern-matching probe generates hypotheses; a wrong hypothesis that reaches a written conclusion is exactly the failure
//   class this line of work keeps meeting — R574's offset, R617's offsets, R618's corrected citations. The instruments are right;
//   what was wrong was my reading of two field names.
//
// WHAT IS NOT CLAIMED
//   Not that no snapshot assertion can go stale: R617's counters DID go stale three rounds running, which is why R620 rewrote them
//   as relations. That was real and is fixed. What this shows is that it is not a widespread class.
//   Not that the four matched pairs will keep matching: each is a record recomputed by a test, so a tool change breaks the record —
//   and that failure is the signal, by design.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ASSERTIONS, FALSE_ALARMS, AGREEMENTS } from '../desktop/snapshot-assertions.cjs';
import * as ufMod from '../desktop/unasserted-fields.cjs';
import * as rmMod from '../desktop/rescan-after-mask.cjs';
import * as scMod from '../desktop/sort-census.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runJson = (tool) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', tool), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `${tool} failed:\n` + (r.stderr || '').slice(0, 400));
  return JSON.parse(r.stdout);
};

test('the four record-versus-tool pairs still agree', () => {
  const uf = ufMod;
  const rm = rmMod;
  const maps = runJson('map-key-reach.cjs');
  const sd = runJson('source-divergence.cjs');

  assert.equal(uf.DERIVED_PAIR.counts2, maps.unstableDisagree, 'counts2 drifted from unstableDisagree');
  assert.equal(uf.DERIVED_PAIR.counts, maps.rows.filter((r) => r.unstableSet).length,
    'counts drifted from the unstableSet row count');
  assert.equal(rm.CHANGE.after, sd.candidates, 'rescan-after-mask.after drifted from the candidate count');

  // The sort-census tie count for map-key-reach, recomputed the same way the record was.
  const score = (r) => (r.readKey === null ? 0 : (r.agrees ? 0 : 2) + (r.unstableSet ? 3 : 0));
  const groups = new Map();
  for (const r of maps.rows) {
    const k = score(r) + '|' + r.file;
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  const ties = [...groups.values()].filter((n) => n > 1).length;
  const sc = scMod;
  const row = sc.SORTING.find((s) => s.tool.endsWith('map-key-reach.cjs'));
  assert.equal(row.tiedGroups, ties, 'the recorded tie count drifted');
});

test('every recorded agreement matches its measured value', () => {
  assert.equal(AGREEMENTS.length, 4);
  for (const a of AGREEMENTS) {
    assert.equal(a.value, a.toolValue, `${a.record} disagrees with ${a.tool}`);
  }
});

test('the two false alarms are recorded as reading errors, not data errors', () => {
  assert.equal(FALSE_ALARMS.length, 2);
  for (const f of FALSE_ALARMS) {
    assert.equal(f.reported, 'DRIFT', 'the alarm is no longer described as a drift report');
    assert.match(f.actual, /array of 3|unstableDisagree/, 'the real cause is not stated');
  }
});

test('the assertion census is recorded with its synthetic-data caveat', () => {
  assert.equal(ASSERTIONS.sites, 447);
  assert.equal(ASSERTIONS.countingFiles, 4);
  assert.equal(ASSERTIONS.allSynthetic, true);
  assert.match(ASSERTIONS.note, /fabricated diffs/, 'the synthetic-data reason is not stated');
  assert.match(ASSERTIONS.verdict, /does not exist at scale/, 'the verdict is not stated');
});

test('the record keeps the earlier real instance distinct', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'snapshot-assertions.cjs'), 'utf8');
  assert.match(src, /R617's counters DID go stale/, 'the real instance is not distinguished from the non-problem');
  assert.match(src, /failure is the signal/, 'the intended behaviour is not stated');
});
