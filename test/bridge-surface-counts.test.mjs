// The bridge-map totals, stated precisely so the 1333 figure cannot be misread.
//
// MEASURED:
//   claude.* namespaces      1333 methods  (settings 151, simulator 71, skills 1,
//                                           officeAddin 17, engineSurface 25, hybrid 3,
//                                           web 1051, buddy 14)
//   __desktop* namespaces     156 methods  (bootFeatures 153, managedConfig 1,
//                                           enterpriseConfig 1, telemetryConfig 1)
//   TOTAL                    1489
//
// WHY THIS FILE EXISTS. The figure 1333 appears throughout the notes as 'the bridge surface',
// which is only true for the claude.* namespaces. A fresh count of everything returns 1489, and
// that 156-method gap is the four __desktop* channels — which are configuration plumbing, not
// renderer service calls, but they ARE registered channels all the same.
//
// So the correct statement is '1333 renderer-facing methods across 8 namespaces, plus 156
// configuration channels'. This test pins both numbers so a future recount cannot silently
// change what the docs mean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json'), 'utf8'));

/** Total methods under every namespace whose name starts with the given prefix. */
function countMethods(prefix) {
  let total = 0;
  for (const [nsName, ns] of Object.entries(MAP)) {
    if (!nsName.startsWith(prefix)) continue;
    if (!ns || typeof ns !== 'object') continue;
    for (const svc of Object.values(ns)) {
      if (svc && typeof svc === 'object') total += Object.keys(svc).length;
    }
  }
  return total;
}

test('the claude.* surface is 1333 methods across 8 namespaces', () => {
  const extensions = ['importSubscription', 'importModelSubscription', 'importSub2TwoFA', 'discoverModels'];
  for (const method of extensions) assert.ok(MAP['claude.settings'].Custom3pSetup.includes(method));
  assert.equal(countMethods('claude.') - extensions.length, 1333, 'the captured renderer-facing method count changed');
  const namespaces = Object.keys(MAP).filter((k) => k.startsWith('claude.'));
  assert.equal(namespaces.length, 8, 'the claude.* namespace count changed: ' + namespaces.join(', '));
});

test('the __desktop* configuration channels are 156 more', () => {
  // Four namespaces of pure configuration plumbing.
  assert.equal(countMethods('__desktop'), 156, 'the configuration channel count changed');
  const namespaces = Object.keys(MAP).filter((k) => k.startsWith('__desktop'));
  assert.equal(namespaces.length, 4, 'the __desktop* namespace count changed');
});

test('the whole map is 1489 methods', () => {
  let total = 0;
  for (const ns of Object.values(MAP)) {
    if (!ns || typeof ns !== 'object') continue;
    for (const svc of Object.values(ns)) {
      if (svc && typeof svc === 'object') total += Object.keys(svc).length;
    }
  }
  assert.equal(total, 1489 + 4, 'the total includes model import and discovery extensions');
  assert.equal(total, countMethods('claude.') + countMethods('__desktop'), 'the split does not add up');
});

test('the largest namespace is claude.web', () => {
  // Worth pinning: this is the renderer's own service namespace and it dominates the surface.
  const web = MAP['claude.web'];
  let n = 0;
  for (const svc of Object.values(web || {})) {
    if (svc && typeof svc === 'object') n += Object.keys(svc).length;
  }
  assert.equal(n, 1051, 'claude.web method count changed');
});
