'use strict';
// `tabAdmissions` is keyed three different ways at three sites, and one of them can never be read back.
//
// THE THREE SITES (desktop/preview-access.cjs, minified onto few lines)
//       :8756   tabAdmissions.set(serverId + '\0' + (query.tabId ?? where?.tabId ?? 'seed'), origin)
//       :9011   tabAdmissions.get(serverId + '\0' + where.tabId) === origin
//       :11408  tabAdmissions.set(state.card.serverId + '\0' + state.card.tabId, state.origin)
//
// WHAT EACH KEY CAN BE
//       the write at :8756   three sources with two fallbacks ending in the literal 'seed'
//       the read  at :9011   `where.tabId` only — no `query`, no 'seed', and `where` may be undefined
//       the write at :11408   `state.card.tabId`
//
//   The read at :9011 is narrower than the write at :8756, so any admission recorded under the 'seed' fallback or from
//   `query.tabId` is unreadable. And `where?.tabId` in the read is not optional-chained the same way as the write's
//   `where?.tabId` fallback — at :9011 it is plain `where.tabId` inside a `&&` chain that already tested `where?.origin`, so
//   `where` is known non-null there; the mismatch is the missing `query` and `'seed'`, not the chaining.
//
// WHY THIS IS THE FIRST REAL FINDING OF THIS SHAPE
//   R594 read 33 Map key differences and all were false: two names for one value, or a protocol pairing, or a stable call.
//   This one is none of those. It is not two names for one value — the expressions genuinely produce different strings when
//   `query.tabId` is set or when both ids are absent. It is not a protocol pairing — all three sites are in one module. It is
//   not a stable call — it is a concatenation whose operand list differs.
//
//   R596 is what surfaced it: widening the declaration pattern to see comma-separated declarations raised the Map population
//   from 167 to 202, and the six "unstable" rows became visible — including this one, which the narrower population never
//   reached because its declaration shares a line with five others.
//
// WHAT IT COSTS, AND WHAT IT DOES NOT
//   The admission map exists so a tab that already answered a permission prompt is not asked again. A key that cannot be read
//   back means the prompt reappears — an annoyance, not a security hole: the fall-through at :9011 leads to the normal verdict
//   path, which asks again. Nothing is over-permitted; something is under-remembered.
//
//   That is the safe direction, and it is worth stating because the opposite (a read that finds an admission nobody wrote)
//   would be the dangerous one and is impossible here: the read is a strict subset of the write.
//
// WHAT IS NOT CLAIMED
//   Not that this is a defect worth fixing without a decision: widening the READ to match the write is one line, but it
//   changes behaviour — more admissions remembered — and that is a product decision, not a cleanup.
//   Not that the other five "unstable" rows are fine: `hostPending`, `once` and two more are stable calls like `watcherKey`;
//   `audit-evidence`'s `out` is `Number(...)`. All five were re-read and none is this shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'desktop', 'preview-access.cjs');
const TOOL = path.join(ROOT, 'tools', 'map-key-reach.cjs');

test('the three key expressions are still different', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const writes = [...src.matchAll(/tabAdmissions\.set\(([^,]+),/g)].map((m) => m[1].trim());
  const reads = [...src.matchAll(/tabAdmissions\.get\(([^)]+)\)/g)].map((m) => m[1].trim());
  assert.equal(writes.length, 2, `expected two writes, found ${writes.length}`);
  assert.equal(reads.length, 1, `expected one read, found ${reads.length}`);

  // The read is narrower: no `query`, no 'seed'.
  assert.match(reads[0], /where\.tabId/, 'the read no longer uses where.tabId');
  assert.ok(!/query/.test(reads[0]), 'the read now covers query.tabId — the asymmetry is closed');
  assert.ok(!/seed/.test(reads[0]), 'the read now covers the seed fallback — the asymmetry is closed');

  // One write does have both.
  const wide = writes.find((w) => /query\.tabId/.test(w) && /seed/.test(w));
  assert.ok(wide, 'no write carries the full fallback chain any more');
});

test('the read is a strict subset of the write, so nothing is over-permitted', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const read = [...src.matchAll(/tabAdmissions\.get\(([^)]+)\)/g)][0][1];
  // The read keys on `serverId + '\0' + where.tabId`; the wide write keys on `serverId + '\0' + (query.tabId ?? where?.tabId
  // ?? 'seed')`. Every string the read can produce is also producible by the write (when query.tabId is absent).
  assert.match(read, /serverId\s*\+\s*'\\0'\s*\+\s*where\.tabId/,
    'the read key shape changed, so the subset argument no longer applies');
});

test('the scan now reaches this map, which the narrower population did not', () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 600));
  const d = JSON.parse(r.stdout);
  const row = d.rows.find((x) => x.name === 'tabAdmissions');
  assert.ok(row, 'tabAdmissions is not reported — the comma-declaration fix may have regressed');
  assert.equal(row.agrees, false, 'the keys now agree, so the finding is stale');
  assert.ok(d.maps > 190, `only ${d.maps} maps: the comma-form declarations are not being counted`);
});

test('the public page reads this as a prompt reappearing, not a permission leak', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'preview-access.cjs'), 'utf8');
  // The read site falls through to the normal verdict path when the admission is missing.
  const around = src.slice(src.indexOf('tabAdmissions.get'), src.indexOf('tabAdmissions.get') + 260);
  assert.match(around, /return\{kind:'allow'\}|return \{ kind: 'allow' \}/,
    'the read site no longer short-circuits to allow, which was the basis for "under-remembered"');
});
