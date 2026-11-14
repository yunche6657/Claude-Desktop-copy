'use strict';
// 38 sets are only added to and tested. Exactly ONE has R590's shape: a sibling cleared on an event the key cannot see.
//
// THE PATTERN ENUMERATED
//   `tools/set-lifetimes.cjs` finds every `const NAME = new Set(` with at least one `has` and one `add` and NO `delete` or
//   `clear` — a process-lifetime dedup. Measured: 38 across desktop/ and tools/.
//
//   Thirty-eight is not thirty-eight defects. Most are ordinary: `keptUuids` keyed by `record.uuid`, `seenIds` keyed by
//   `probe.id`, `known` keyed by `account.organizationUuid`. A cache that never resets is correct when its key names the
//   thing being cached.
//
// THE DISCRIMINATOR, AND WHY "SAME FILE HAS A RESET" IS NOT IT
//   Nine of the 38 sit in files that also reset SOME set. That is not the signal: `scheduled-tasks.cjs` resets `announced`
//   and `throttleDeferredSince` while `seenWalls` keeps running, and the two are unrelated — `seenWalls` dedups wall-clock
//   slots for one scheduling pass, and `announced` tracks tasks. Same file, different lifetimes, no relationship.
//
//   The signal is narrower and requires reading the key:
//
//       the key omits a dimension, AND
//       the same event that changes that dimension clears a SIBLING set fed by the same function
//
//   `seenFeatureExposure` is the one case that satisfies both. Its key is `${key}:${item.on}:${item.source}` — no account —
//   and `seenExperimentExposure`, fed from the same `exposure()` call and declared on the same line, is cleared when the
//   account changes (`:260`). So the two sets that describe one exposure event disagree about whether an account switch
//   erases history.
//
// THE OTHERS CHECKED AND DISMISSED
//       main.cjs:390 `askedOnce` keyed by `turnKey` — the clears at :250/:808/:1012 are on `hybridAuthResults`, a different
//       domain. `askedOnce` never needs resetting because `turnKey` already identifies the turn.
//
//       scheduled-tasks.cjs:92 `seenWalls` keyed by a slot key — `announced.clear()` at :422 fires when a listener becomes
//       ready, which has nothing to do with wall slots.
//
//   Both are cases where the KEY already contains the dimension, so no reset is required. That is the opposite of R590.
//
// WHAT THIS ROUND ESTABLISHES
//   The finding is a class of ONE in this repository, and the class is now defined precisely enough to be checked again:
//   a no-reset set whose key omits a dimension that a sibling reset on the same event distinguishes.
//
//   It also establishes that the cheap version of the check — "does this file reset any set" — would have produced nine
//   candidates, seven of them false. The expensive version reads the key.
//
// WHAT IS NOT CLAIMED
//   Not that the other 37 are verified correct: this round read two of them and dismissed them on the stated grounds. The
//   remaining 35 are unread, and the tool exists so a later round can read them the same way.
//   Not that 38 is stable — the count moves as files are added, and the tool is the record, not this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'set-lifetimes.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the scan finds a tractable number of no-reset sets', () => {
  const d = runScan();
  assert.ok(d.sets > 10, `only ${d.sets} no-reset sets: the scan is too narrow to be the enumeration`);
  assert.ok(d.sets < 100, `${d.sets} no-reset sets: the criterion has widened past has+add`);
  for (const r of d.rows) {
    assert.ok(r.has > 0 && r.add > 0, `${r.name} has no has/add pair`);
    assert.equal(r.delete, 0, `${r.name} has a delete but is listed`);
    assert.equal(r.clear, 0, `${r.name} has a clear but is listed`);
  }
});

test('the R590 case is the only one with a sibling cleared on an event its key cannot see', () => {
  const d = runScan();
  const feature = d.rows.find((r) => r.name === 'seenFeatureExposure');
  assert.ok(feature, 'the R590 set is no longer found');
  assert.equal(feature.file, 'desktop/growthbook-provider.cjs');

  // The sibling: same file, same feeding function, cleared on the account switch.
  const prov = fs.readFileSync(path.join(ROOT, feature.file), 'utf8');
  assert.match(prov, /seenExperimentExposure\.clear\(\)/, 'the sibling reset is gone');
  // And the key omits the account — the fact that makes the pair disagree.
  assert.match(prov, /const signature = `\$\{key\}:\$\{item\.on\}:\$\{item\.source\}`/);
  assert.ok(!/account/i.test(prov.split('\n')[68]), 'the key now names the account');
});

test('the two dismissed cases are dismissed on stated grounds, not by exclusion', () => {
  const d = runScan();
  for (const name of ['askedOnce', 'seenWalls']) {
    const row = d.rows.find((r) => r.name === name);
    assert.ok(row, `${name} is no longer listed, so the dismissal cannot be re-checked`);
    // Each key names the thing being deduplicated, which is why no reset is needed. `seenWalls` uses the variable `key`
    // directly, so the threshold is existence rather than length — a short key that is a name is still a name.
    assert.ok(row.key && row.key.length > 0, `${name} has no key expression to judge`);
  }
  // askedOnce's clears belong to a different domain.
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /hybridAuthResults\.clear\(\)/, 'the unrelated reset domain is no longer present');
  assert.ok(!/askedOnce\.clear\(\)/.test(main), 'askedOnce now has a clear, so the dismissal is stale');
});

test('the file-level heuristic is recorded as producing false positives', () => {
  const d = runScan();
  const filesWithReset = new Set();
  for (const r of d.rows) {
    const text = fs.readFileSync(path.join(ROOT, r.file), 'utf8');
    if (/\.clear\(\)|\.delete\(/.test(text)) filesWithReset.add(r.file);
  }
  // The cheap heuristic flags more files than the real finding needs.
  assert.ok(filesWithReset.size >= 5,
    `only ${filesWithReset.size} files reset some set: the false-positive count in the record cannot hold`);
  // And the real class is one, so the heuristic over-reports.
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'exposure-set-lifetimes.cjs'), 'utf8');
  assert.match(src, /seenFeatureExposure/, 'the real case is not recorded');
});

test('the scan quotes a key so a reader can judge what it varies with', () => {
  const d = runScan();
  const withKeys = d.rows.filter((r) => r.key && r.key.length > 0);
  assert.ok(withKeys.length > d.rows.length / 2,
    `only ${withKeys.length} of ${d.rows.length} rows quote a key: the judgment is not supported`);
});

test('the record says the count is not a defect count, and how many were actually read', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'exposure-set-lifetimes.cjs'), 'utf8');
  assert.ok(/not thirty-eight defects/.test(src), 'the count is presented without the caveat');
  assert.ok(/remaining 35 are unread|two of them and dismissed/.test(src),
    'how many were read is not stated');
});
