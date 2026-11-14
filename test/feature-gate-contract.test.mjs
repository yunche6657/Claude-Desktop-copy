// The unsupported/unsupportedCode pair is load-bearing, not decoration.
//
// MEASURED from the captured boot-feature map:
//   supported    67
//   unsupported  11   <- every one carries both `reason` and `unsupportedCode`
//   unavailable  53   <- none carries extra detail
//
// and from the shipped bundles:
//   `unsupportedCode` appears 94 times across assets/v1
//   e.g. cd2efac6e-Be7wcc4w.js:
//     u = r.unsupportedCode === 'msix_required' || r.unsupportedCode === 'virtualization_entitlement_missing'
//   e.g. c21f11e6d-Cyd8_HO8.js:
//     u.featureGateEnabled === true && u.unsupportedCode !== 'disabled_by_enterprise'
//
// So the renderer branches on the CODE, not on the free-text reason. That is why the 11
// unsupported entries must keep their exact codes: changing one silently changes which UI branch
// runs, and the string never appears in our own source to warn us.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const FEATURES = JSON.parse(read('desktop/shim/bridge-map.json')).__desktopBootFeatures || {};

const UNSUPPORTED = Object.entries(FEATURES).filter(([, v]) => v && v.status === 'unsupported');

test('all 11 unsupported features carry both a reason and a code', () => {
  assert.equal(UNSUPPORTED.length, 11, 'the unsupported set changed size: ' + UNSUPPORTED.length);
  for (const [name, v] of UNSUPPORTED) {
    assert.equal(typeof v.reason, 'string', name + ' lost its reason');
    assert.ok(v.reason.length > 0, name + ' has an empty reason');
    assert.equal(typeof v.unsupportedCode, 'string', name + ' lost its unsupportedCode');
    assert.ok(v.unsupportedCode.length > 0, name + ' has an empty unsupportedCode');
  }
});

test('the platform-gated features keep their exact codes', () => {
  // The renderer compares these strings literally; a typo would change behaviour invisibly.
  assert.equal(FEATURES.yukonSilver.unsupportedCode, 'msix_required');
  assert.equal(FEATURES.iosSimulator.unsupportedCode, 'unsupported_platform');
  assert.equal(FEATURES.tearOffHalo.unsupportedCode, 'unsupported_platform');
  assert.equal(FEATURES.computerUseRollout.unsupportedCode, 'not_enabled');
});

test('unavailable features carry no code, because nothing branches on them', () => {
  // 53 entries, all bare { status: 'unavailable' }. Pinned so adding a code to one is a
  // deliberate change rather than an accident.
  const unavailable = Object.entries(FEATURES).filter(([, v]) => v && v.status === 'unavailable');
  assert.equal(unavailable.length, 53, 'the unavailable set changed size: ' + unavailable.length);
  const withExtra = unavailable.filter(([, v]) => Object.keys(v).length > 1);
  assert.deepEqual(withExtra.map(([k]) => k), [], 'these unavailable features gained extra fields: ' + withExtra.map(([k]) => k).join(', '));
});

test('every feature entry has a status and nothing is missing one', () => {
  const bad = Object.entries(FEATURES).filter(([, v]) => !v || typeof v.status !== 'string');
  assert.deepEqual(bad.map(([k]) => k), [], 'features without a status: ' + bad.map(([k]) => k).join(', '));
});
