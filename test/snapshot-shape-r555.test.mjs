// R555: one version rule in two files, and an ordering difference that looked like a defect and was not.
//
// THE RULE THAT WAS WRITTEN TWICE
//   `desktop/history-import-manifest.cjs` and `desktop/history-import-transaction.cjs` each validated a snapshot's
//   `version` with the same four conditions, character for character. Only the Set field (`sourceSessionIds` vs
//   `cliSessionIds`) and the error message differed. This is the gate on whether a resumed import may proceed, so a
//   change to one copy and not the other would open the gate on one path and not the other.
//
//   Both now call `snapshotProblem(snapshot, idsField)` from `desktop/snapshot-shape.cjs`. The extraction was verified
//   against the original expression on fifteen inputs — including the cases where a naive rewrite would differ:
//
//       version '0'      accepted (a string, non-empty)      — `if (v)` would have rejected it
//       version ''       rejected as empty-string
//       version 1.5      rejected as unsafe-integer          — `Number.isInteger` vs `isSafeInteger` would differ
//       version NaN      rejected as unsafe-integer
//       version Infinity rejected as unsafe-integer
//       version 0        accepted                            — `if (v)` would have rejected it
//
// THE ORDERING DIFFERENCE, CHECKED AND LEFT ALONE
//   In the transaction, `owned`/`version`/`isCurrent` are assigned BEFORE `await isCurrent()` is checked, so a stale
//   snapshot throws after the assignment. That reads like the R551 bug — work done before the check that should
//   prevent it — and it is not: all three are locals of `context()`, which throws before returning, so the values are
//   unreachable from outside. The difference from the manifest path is the ERROR ("unavailable" vs "changed"), and that
//   difference is deliberate.
//
//   Recording this matters as much as the fix: an ordering that looks wrong and is not is exactly the kind of thing a
//   later round "corrects" into a real bug.
//
// WHAT IS NOT CLAIMED
//   Not that the four conditions are the RIGHT validation. `Number.isSafeInteger` rejects 1.5, which is intended for a
//   monotonic counter; whether a string version may be '0' is a product question this module does not decide
//   (`!snapshot.version` rejects '' but accepts '0', and both are preserved as-is).
//   Not that the two paths now behave identically: they differ in error text and in when `isCurrent()` is awaited, and
//   both differences are intentional and documented at the call sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionProblem, snapshotProblem } from '../desktop/snapshot-shape.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the version rule accepts and rejects exactly what the original expression did', () => {
  // The original, transcribed from both files as they were before R555.
  const original = (s) => !['string', 'number'].includes(typeof s.version)
    || (typeof s.version === 'number' && !Number.isSafeInteger(s.version))
    || (typeof s.version === 'string' && !s.version)
    || typeof s.isCurrent !== 'function';

  const cases = [
    { version: 7, isCurrent: () => true },
    { version: 'abc', isCurrent: () => true },
    { version: 0, isCurrent: () => true },                  // truthy-check would wrongly reject
    { version: '0', isCurrent: () => true },                // truthy-check would wrongly reject
    { version: '', isCurrent: () => true },
    { version: 1.5, isCurrent: () => true },
    { version: NaN, isCurrent: () => true },
    { version: Infinity, isCurrent: () => true },
    { version: Number.MAX_SAFE_INTEGER + 2, isCurrent: () => true },
    { version: null, isCurrent: () => true },
    { isCurrent: () => true },
    { version: true, isCurrent: () => true },
    { version: {}, isCurrent: () => true },
    { version: 1 },
    { version: 1, isCurrent: 'yes' },
  ];
  for (const c of cases) {
    const want = original(c);
    const got = versionProblem(c) !== null;
    assert.equal(got, want, `disagreement for ${JSON.stringify(c)}: extracted ${got}, original ${want}`);
  }
});

test('the shared rule reports WHY, so a caller can distinguish the cases', () => {
  assert.equal(versionProblem({ version: 1, isCurrent: () => true }), null);
  assert.equal(versionProblem({ version: '', isCurrent: () => true }), 'empty-string');
  assert.equal(versionProblem({ version: 1.5, isCurrent: () => true }), 'unsafe-integer');
  assert.equal(versionProblem({ version: true, isCurrent: () => true }), 'type');
  assert.equal(versionProblem({ version: 1 }), 'is-current-not-callable');
});

test('the Set field is the only thing the two call sites parameterise', () => {
  const good = { complete: true, cliSessionIds: new Set(), sourceSessionIds: new Set(), version: 1, isCurrent: () => true };
  assert.equal(snapshotProblem(good, 'cliSessionIds'), null);
  assert.equal(snapshotProblem(good, 'sourceSessionIds'), null);
  assert.equal(snapshotProblem({ ...good, cliSessionIds: undefined }, 'cliSessionIds'), 'ids-not-a-set');
  assert.equal(snapshotProblem({ ...good, sourceSessionIds: [] }, 'sourceSessionIds'), 'ids-not-a-set');
  assert.equal(snapshotProblem(null, 'cliSessionIds'), 'absent');
  assert.equal(snapshotProblem({ ...good, complete: false }, 'cliSessionIds'), 'incomplete');
});

test('both files read the shared rule and neither spells the conditions out', () => {
  for (const rel of ['desktop/history-import-manifest.cjs', 'desktop/history-import-transaction.cjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /require\('\.\/snapshot-shape\.cjs'\)/, `${rel} does not import the shared rule`);
    assert.ok(!/Number\.isSafeInteger/.test(src), `${rel} still spells out the version conditions`);
    assert.ok(!/\['string',\s*'number'\]\.includes\(typeof/.test(src),
      `${rel} still contains the type check inline`);
  }
});

test('the ordering difference is recorded as checked, not as a defect', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop/history-import-transaction.cjs'), 'utf8');
  assert.match(src, /locals of `context\(\)`/, 'the reason the early assignment is harmless is not recorded');
  assert.match(src, /checked this instead of "fixing" it/, 'the round that verified it is not named');
});

test('the manifest path keeps isCurrent inside its own guard', () => {
  // A stale snapshot there is reported as "unavailable", the same fact as a malformed one. Moving the call out would
  // change the error a caller sees.
  const src = fs.readFileSync(path.join(ROOT, 'desktop/history-import-manifest.cjs'), 'utf8');
  assert.match(src, /snapshotProblem\(snapshot,\s*'sourceSessionIds'\)\s*\|\|\s*await snapshot\.isCurrent\(\)!==true/,
    'the manifest guard no longer folds isCurrent into the same check');
  assert.match(src, /Complete source manifest snapshot unavailable/, 'the manifest error message changed');
});
