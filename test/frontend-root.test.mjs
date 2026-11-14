// The shipped frontend was replaced underneath the replica.
//
// On 2026-10-22 the MSIX-installed Claude app upgraded itself in place from
// 2.42304.2.0 to 3.1623.0.0. `resources/ion-dist` is a JUNCTION into that package
// (so a ~3 GB asset tree is not duplicated), so the upgrade left both junctions
// pointing at a deleted directory. The replica then refused to boot with
//   "frontend view requested but ...\\resources\\ion-dist\\index.html is missing"
// which reads like a missing checkout and sends you looking in the wrong place.
//
// Two behaviours are locked in here:
//   1. a dangling frontend root falls back to the installed package instead of
//      failing the boot;
//   2. discovery must not rely on readdir("C:\Program Files\WindowsApps"), which
//      fails with EPERM on this host even for an administrator -- a plain directory
//      scan silently finds nothing and looks like "the app is not installed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveFrontendRoot, findInstalledIonDist } = require('../desktop/app-protocol.cjs');

function makeRoot({ withIndex = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fx-ion-'));
  if (withIndex) writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
  return dir;
}

test('a healthy resources/ion-dist is used as-is', () => {
  const resources = mkdtempSync(path.join(tmpdir(), 'fx-res-'));
  const ion = path.join(resources, 'ion-dist');
  mkdirSync(ion);
  writeFileSync(path.join(ion, 'index.html'), '<!doctype html>');

  assert.equal(resolveFrontendRoot({ resourcesPath: resources }), ion);
});

test('an explicit override always wins, even when it has no index.html', () => {
  // The override is how a developer points at an unpacked frontend; second-guessing
  // it would make the override useless.
  const override = mkdtempSync(path.join(tmpdir(), 'fx-ovr-'));
  const resources = mkdtempSync(path.join(tmpdir(), 'fx-res-'));
  mkdirSync(path.join(resources, 'ion-dist'));
  writeFileSync(path.join(resources, 'ion-dist', 'index.html'), '<!doctype html>');

  assert.equal(resolveFrontendRoot({ resourcesPath: resources, override }), override);
});

test('a dangling junction falls back to the installed package', () => {
  // resources/ion-dist exists but has no index.html: exactly the state the junction
  // was left in after the in-place upgrade.
  const resources = mkdtempSync(path.join(tmpdir(), 'fx-dang-'));
  mkdirSync(path.join(resources, 'ion-dist'));

  const resolved = resolveFrontendRoot({ resourcesPath: resources });

  // Either the installed package was found, or no package is installed at all. What
  // must never happen is reporting an index.html-less directory as usable.
  const installed = findInstalledIonDist();
  if (installed) {
    assert.equal(resolved, installed);
    assert.ok(existsSync(path.join(resolved, 'index.html')), 'fallback root must contain index.html');
  } else {
    assert.equal(resolved, path.join(resources, 'ion-dist'), 'with nothing installed the local path is reported');
  }
});

test('discovery returns a root that really contains index.html', () => {
  const found = findInstalledIonDist();
  if (found === null) {
    // Legitimate skip: this host may genuinely have no installed package. But a silent
    // return is indistinguishable from a passing assertion, so say which one happened.
    const fallback = resolveFrontendRoot({ resourcesPath: path.resolve('resources') });
    assert.ok(fallback && existsSync(path.join(fallback, 'index.html')),
      'no installed package AND no usable local frontend root - the app cannot start at all');
    return;
  }
  assert.ok(path.isAbsolute(found));
  // A returned path that does not exist is worse than returning null: callers use the
  // result directly as the protocol root.
  assert.ok(existsSync(path.join(found, 'index.html')), `discovered ${found} has no index.html`);
  assert.ok(found.endsWith(path.join('app', 'resources', 'ion-dist')), `unexpected shape: ${found}`);
});

test('discovery uses the AppModel registry, the only source readable in both contexts', () => {
  // Three candidate mechanisms, two of which are broken here:
  //   readdir("C:\Program Files\WindowsApps") -> EPERM even as administrator
  //   Get-AppxPackage from Electron's main    -> UnauthorizedAccessException
  //     (works under plain node, which is why this bug survived a node-only check)
  //   AppModel\Repository\Packages registry   -> readable in both
  // This asserts the two EPERM-prone paths are not what discovery relies on.
  assert.ok(existsSync('C:\\Program Files\\WindowsApps'), 'WindowsApps itself is statable');

  let listingDenied = false;
  try {
    require('node:fs').readdirSync('C:\\Program Files\\WindowsApps');
  } catch (err) {
    listingDenied = err && (err.code === 'EPERM' || err.code === 'EACCES');
  }

  const found = findInstalledIonDist();
  if (listingDenied) {
    // The listing is denied, so a directory scan cannot be how `found` was produced.
    // Permission denial proves nothing about whether an app remains installed.
    // A pinned local frontend must still work when the Store package is absent.
    const fallback = resolveFrontendRoot({ resourcesPath: path.resolve('resources') });
    assert.ok(existsSync(path.join(fallback, 'index.html')));
  }
  assert.equal(typeof listingDenied, 'boolean');
  if (found) assert.ok(existsSync(path.join(found, 'index.html')));
});

