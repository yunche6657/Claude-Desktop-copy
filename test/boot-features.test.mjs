// Boot features reach the renderer, and exactly four are overridden by the packaging signal.
//
// MEASURED live (:10640):
//   window.top.desktopBootFeatures  present, 131 entries
//   window.desktopBootFeatures      present (same object)
//   sample                          launch=supported, coworkBrowser=supported, artifactsPane=unavailable
//
// The captured map says coworkBrowser is UNSUPPORTED (reason cowork_browser_disabled). The live
// value says supported. That difference is deliberate and comes from withPackaging() in
// desktop/preload-frontend.cjs: when packagingState().isMsix is true it flips
//
//   yukonSilver, yukonSilverGems, yukonSilverGemsCache, coworkBrowser
//
// to { status: 'supported' }. The comments there explain why: the captured payload came from a
// machine where the modern-installer check failed and where there was no browser integration, so
// a packaged run has to report the supported state it actually represents.
//
// WHY THIS MATTERS. The renderer only reads `.status` (frame-shell-BNblcN6E.js:
//   n?.[r]?.status === 'supported' && t.add(r)   where n = window.top?.desktopBootFeatures)
// and trayIcon's UI switches on it (c71860c77: je(l,'trayIcon').status === 'unsupported').
// So the OBJECT is the whole contract — no per-feature IPC is needed, which is why 66 of the 67
// 'supported' names appear nowhere in our own source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const MAP = JSON.parse(read('desktop/shim/bridge-map.json'));
const FEATURES = MAP.__desktopBootFeatures || {};

test('the captured boot-feature map has 131 entries with three possible statuses', () => {
  const keys = Object.keys(FEATURES);
  assert.equal(keys.length, 131, 'the boot feature count changed: ' + keys.length);
  const statuses = new Set(keys.map((k) => FEATURES[k] && FEATURES[k].status));
  // Compared as a SET, not a sorted array: the expected order here is alphabetical by accident.
  assert.deepEqual([...statuses].sort(), ['supported', 'unavailable', 'unsupported'],
    'an unexpected status appeared: ' + [...statuses].join(', '));
});

test('the four packaging-gated features are overridden at runtime', () => {
  // The preload flips exactly these when the install declares MSIX packaging.
  const preload = read('desktop/preload-frontend.cjs');
  assert.match(preload, /function withPackaging\(features\)/, 'the packaging override is gone');
  for (const key of ['yukonSilver', 'yukonSilverGems', 'yukonSilverGemsCache']) {
    assert.ok(preload.includes(key), key + ' is no longer overridden');
  }
  assert.match(preload, /out\.coworkBrowser = \{ status: 'supported' \}/, 'coworkBrowser override is gone');
});

test('the override is gated on a declared MSIX packaging state', () => {
  // Without the gate every build would claim Cowork support.
  const preload = read('desktop/preload-frontend.cjs');
  assert.match(preload, /if \(!declared\.isMsix\) return features;/, 'the packaging gate was removed');
});

test('the renderer consumes only .status, so no per-feature channel is required', () => {
  // Pins the reason 66 'supported' names appear nowhere in our source: the object is enough.
  const map = read('desktop/shim/bridge-map.json');
  assert.ok(map.includes('__desktopBootFeatures'), 'the boot feature block left the bridge map');
  // And the preload exposes it as a plain object on window.
  const preload = read('desktop/preload-frontend.cjs');
  assert.match(preload, /expose\('desktopBootFeatures'/, 'desktopBootFeatures is not exposed');
});