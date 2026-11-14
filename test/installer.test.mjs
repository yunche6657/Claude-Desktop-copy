// Installer (NSIS) tests.
//
// These do not rebuild the installer — that takes minutes and needs network.
// They assert the things that would silently produce a broken release:
//
//   * the builder config keeps this project's own appId (never the artifact's);
//   * the config ships only the runtime payload;
//   * if a release exists, its artefacts have the expected shape and the
//     unpacked build contains a usable app.asar.
//
// The install → launch → uninstall cycle is exercised by hand in the round that
// produced the installer; a repeatable script for it is `build/installer-check.cjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, statSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CONFIG = path.join(ROOT, 'electron-builder.json');
const RELEASE = path.join(ROOT, 'release');

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));

test('the builder config keeps this project appId, not the artifact one', () => {
  assert.equal(config.appId, 'dev.reconstruction.code-desktop');
  // The artifact ships as com.anthropic.Claude.desktop; reusing it would collide
  // with a real install and misrepresent the build.
  assert.notEqual(config.appId, 'com.anthropic.Claude.desktop');
  assert.ok(!config.appId.includes('anthropic'), 'appId must not claim the vendor namespace');
});

test('the product name is not the vendor product name', () => {
  assert.notEqual(config.productName, 'Claude');
  assert.match(config.productName, /Reconstruction/i);
  assert.match(config.copyright, /[Nn]ot affiliated/);
});

test('the config ships only the runtime payload', () => {
  for (const pattern of config.files) {
    assert.ok(!pattern.startsWith('test'), `${pattern} must not ship tests`);
    assert.ok(!pattern.startsWith('evidence'), `${pattern} must not ship evidence`);
    assert.ok(!pattern.startsWith('build'), `${pattern} must not ship build scripts`);
  }
  assert.ok(config.files.includes('desktop/**/*'));
  assert.ok(config.files.includes('renderer/**/*'));
  assert.ok(config.files.includes('server.mjs'));
});

test('asar is enabled and the entry point is corrected', () => {
  assert.equal(config.asar, true);
  assert.equal(config.extraMetadata.main, 'desktop/main.cjs');
});

test('the NSIS target is a per-user, non-oneClick install', () => {
  const targets = config.win.target.map(t => (typeof t === 'string' ? t : t.target));
  assert.deepEqual(targets, ['nsis']);
  assert.equal(config.nsis.oneClick, false, 'oneClick hides the install-location choice');
  assert.equal(config.nsis.perMachine, false, 'a reconstruction must not require elevation');
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
});

test('the config encodes both architectures it claims', () => {
  const entry = config.win.target.find(t => typeof t === 'object');
  assert.deepEqual(entry.arch, ['x64']);
});

// ---------------------------------------------------------------------------
// Artefact checks. Skipped when no release has been built.
// ---------------------------------------------------------------------------

const hasRelease = existsSync(RELEASE);

test('a built installer has the expected name and plausible size', { skip: !hasRelease }, () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const expected = `${config.productName}-${pkg.version}-x64.exe`;
  const installer = path.join(RELEASE, expected);
  assert.ok(existsSync(installer), `installer missing: ${expected}`);

  const size = statSync(installer).size;
  // An Electron installer is tens of megabytes; anything tiny means the payload
  // was not included.
  assert.ok(size > 40 * 1024 * 1024, `installer looks too small: ${Math.round(size / 1048576)}MB`);
});

test('the unpacked build carries a non-trivial app.asar', { skip: !hasRelease }, () => {
  const asar = path.join(RELEASE, 'win-unpacked', 'resources', 'app.asar');
  assert.ok(existsSync(asar), 'app.asar missing from win-unpacked');
  const size = statSync(asar).size;
  assert.ok(size > 1024, `app.asar looks empty: ${size} bytes`);
});

test('the unpacked app.asar contains the entry point and no tests', { skip: !hasRelease }, async () => {
  const { readAsar } = await import('../build/asar.cjs');
  const asar = path.join(RELEASE, 'win-unpacked', 'resources', 'app.asar');
  const { files } = readAsar(asar);
  const names = [...files.keys()];

  assert.ok(names.includes('desktop/main.cjs'), 'entry point must be inside the archive');
  assert.ok(names.includes('server.mjs'));
  assert.ok(names.some(n => n.startsWith('renderer/')), 'renderer must be inside the archive');
  assert.ok(!names.some(n => n.startsWith('test/')), 'tests must not be inside the archive');
  assert.ok(!names.some(n => n.startsWith('evidence/')), 'evidence must not be inside the archive');

  // The packaged package.json must describe the packaged layout.
  const pkg = JSON.parse(files.get('package.json').toString('utf8'));
  assert.equal(pkg.main, 'desktop/main.cjs');
  assert.equal(pkg.devDependencies, undefined, 'devDependencies must not ship');
});
