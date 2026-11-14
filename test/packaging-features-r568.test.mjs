// R568: main.cjs is 1348 lines with no exports, so "tested" could only ever mean "a test searched its text". Measured.
//
// WHAT THE MEASUREMENT FOUND
//   tools/indirect-tested-hotspots.cjs counts, per module, how many evidence documents mention its basename and whether
//   any test imports it directly. `desktop/main.cjs` was the row that mattered: 44 mentions, ZERO direct importers.
//
//   That is structural, not neglect — main.cjs has no `module.exports` and opens an Electron window when loaded, so no
//   test can require it. Whatever the 28 files that name it assert, they assert about its SOURCE TEXT.
//
//   So the question became narrower: within main.cjs, which top-level functions does any test name at all? Six were named
//   by at least one test. Two were named by none:
//
//       chooseKernel          picks a backend from an env var and two probes
//       withPackagingState    decides which features a packaged build advertises
//
//   The second is user-facing behaviour chosen by a boolean: if it is wrong, a packaged build offers features it cannot
//   run, or a portable one loses features it should have. It is also PURE — it took a features map and consulted the
//   packaging state. Extracting it was a move, not a rewrite.
//
// WHAT CHANGED
//   `desktop/packaging-features.cjs` now owns `PACKAGED_FEATURES` and `applyPackagingState(features, state)`; main.cjs
//   keeps a three-line `withPackagingState` that passes `packagingState()` in. The state is now a PARAMETER, which is what
//   makes the function testable at all.
//
// THE POLICY THAT MUST NOT BE LOST
//   Only features already TRUTHY in the map are rewritten. An absent feature is not added — granting a capability the
//   bridge map never offered is the one outcome this function must not produce. That is the `if (out[key])` guard, and it
//   is the kind of line that disappears during a "simplification".
//
// WHAT IS NOT CLAIMED
//   Not that main.cjs is now tested. 1347 of its lines are still reached only by text search; this round moved ONE pure
//   decision out, and `chooseKernel` remains in the same position.
//   Not that a mention count is an edit count — evidence prose says "X was NOT changed" as readily as "X was changed".
//   Not that the extraction changed behaviour: the body is the same statements with `declared` supplied by the caller
//   instead of read inside.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PACKAGED_FEATURES, applyPackagingState } from '../desktop/packaging-features.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a non-MSIX build passes the feature map through untouched', () => {
  const features = { yukonSilver: { status: 'hidden' }, other: { status: 'hidden' } };
  const out = applyPackagingState(features, { isMsix: false });
  assert.equal(out, features, 'the same object should come back, not a copy with changes');
});

test('an MSIX build marks the packaged features supported', () => {
  const features = {
    yukonSilver: { status: 'hidden' },
    yukonSilverGems: { status: 'hidden' },
    yukonSilverGemsCache: { status: 'hidden' },
    coworkBrowser: { status: 'hidden' },
    unrelated: { status: 'hidden' },
  };
  const out = applyPackagingState(features, { isMsix: true });
  for (const key of PACKAGED_FEATURES) {
    assert.deepEqual(out[key], { status: 'supported' }, `${key} was not marked supported`);
  }
  assert.deepEqual(out.unrelated, { status: 'hidden' }, 'a feature outside the packaged set was rewritten');
  assert.deepEqual(features.yukonSilver, { status: 'hidden' }, 'the input map was mutated');
});

test('an ABSENT feature is never added — the map grants nothing it did not offer', () => {
  // This is the policy line: `if (out[key])`, not `key in out`.
  const out = applyPackagingState({ unrelated: { status: 'hidden' } }, { isMsix: true });
  for (const key of PACKAGED_FEATURES) {
    assert.equal(key in out, false,
      `${key} was ADDED by the packaging gate, granting a capability the bridge map never offered`);
  }
  assert.deepEqual(out, { unrelated: { status: 'hidden' } });
});

test('a falsy feature stays as it is', () => {
  // 'hidden' as a bare string is truthy and becomes {status}; `false` and `null` are not.
  const out = applyPackagingState({ yukonSilver: false, coworkBrowser: null, yukonSilverGems: 0 }, { isMsix: true });
  assert.equal(out.yukonSilver, false);
  assert.equal(out.coworkBrowser, null);
  assert.equal(out.yukonSilverGems, 0);
});

test('a missing state is treated as not packaged', () => {
  // `packagingState()` is allowed to return nothing useful; the gate must not throw or grant.
  const features = { yukonSilver: { status: 'hidden' } };
  assert.equal(applyPackagingState(features, undefined), features);
  assert.equal(applyPackagingState(features, {}), features);
  assert.equal(applyPackagingState(features, null), features);
});

test('main.cjs delegates to the module and no longer spells the policy out', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  assert.match(src, /require\('\.\/packaging-features\.cjs'\)/, 'main.cjs does not import the module');
  assert.match(src, /return applyPackagingState\(features, packagingState\(\)\);/, 'the delegation is gone');
  assert.ok(!/'yukonSilverGemsCache'/.test(src),
    'main.cjs still lists the packaged features: the list has not moved');
});

test('the extraction did not change behaviour', () => {
  // The original body, transcribed, compared against the module across every input combination that matters.
  const original = (features, declared) => {
    if (!declared.isMsix) return features;
    const out = { ...features };
    for (const key of ['yukonSilver', 'yukonSilverGems', 'yukonSilverGemsCache', 'coworkBrowser']) {
      if (out[key]) out[key] = { status: 'supported' };
    }
    return out;
  };
  const cases = [
    [{}, { isMsix: true }],
    [{ yukonSilver: { status: 'hidden' } }, { isMsix: true }],
    [{ yukonSilver: false, coworkBrowser: { status: 'x' } }, { isMsix: true }],
    [{ yukonSilver: { status: 'hidden' } }, { isMsix: false }],
    [{ a: 1, yukonSilverGems: { status: 'hidden' } }, { isMsix: true }],
  ];
  for (const [features, state] of cases) {
    assert.deepEqual(
      applyPackagingState(features, state),
      original(features, state),
      `disagreement for ${JSON.stringify({ features, state })}`,
    );
  }
});

test('the hotspot tool reports which modules no test imports', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'indirect-tested-hotspots.cjs'), '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 600));
  const d = JSON.parse(r.stdout);
  assert.ok(d.modules > 100, `only ${d.modules} modules scanned`);
  assert.ok(d.noDirectTest > 0, 'the tool found no untested hotspots, which contradicts main.cjs');
  const main = d.rows.find((x) => x.file === 'desktop/main.cjs');
  assert.ok(main, 'main.cjs is not in the hotspot list');
  assert.equal(main.directImporters, 0, 'main.cjs is now imported by a test, which would be news');
});
