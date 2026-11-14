// Packaging tests.
//
// These assert the two things that decide whether a build is shippable: the
// manifest carries this project's own identity (never the artifact's), and the
// staged tree contains exactly what the app needs and nothing from the source
// repo that must not ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildManifest, resolveShipList, verifyBuild, WINDOW, SHIP, EXCLUDE } =
  require('../build/packaging.cjs');
const { isRuntimeBackup } = require('../build/packaging.cjs');
const { parseArgs, stage, stageRuntime } = require('../build/build.cjs');

const ROOT = path.resolve(here, '..');

// The shipped product identity, recorded in the artifact's package.json.
const ARTIFACT_IDENTITY = {
  name: '@ant/desktop',
  productName: 'Claude',
  desktopName: 'com.anthropic.Claude.desktop',
};

test('the window geometry matches the measured values', () => {
  assert.equal(WINDOW.width, 1936);
  assert.equal(WINDOW.height, 1048);
  assert.ok(WINDOW.minWidth < WINDOW.width);
  assert.ok(WINDOW.minHeight < WINDOW.height);
});

test('the manifest never reuses the artifact app identity', () => {
  const manifest = buildManifest(ROOT);
  assert.notEqual(manifest.name, ARTIFACT_IDENTITY.name,
    'shipping under @ant/desktop would collide with a real install');
  assert.notEqual(manifest.productName, ARTIFACT_IDENTITY.productName);
  assert.equal(manifest.name, 'code-desktop-reconstruction');
});

test('the manifest points at this app entry point, not the artifact one', () => {
  const manifest = buildManifest(ROOT);
  assert.equal(manifest.main, 'desktop/main.cjs');
  assert.notEqual(manifest.main, '.vite/build/index.pre.js');
});

test('the manifest ships only the runtime payload', () => {
  const manifest = buildManifest(ROOT);
  assert.deepEqual(manifest.files, SHIP);
  for (const entry of ['test', 'evidence', 'ccd-ref']) {
    assert.ok(!manifest.files.includes(entry), `${entry} must not ship`);
  }
});

test('an unknown target is refused', () => {
  assert.throws(() => buildManifest(ROOT, { target: 'appimage' }), /unknown target/);
});

test('each target adds the fields it needs and nothing else', () => {
  const dir = buildManifest(ROOT, { target: 'dir' });
  assert.equal(dir.windows, undefined);

  const msix = buildManifest(ROOT, { target: 'msix' });
  assert.ok(msix.windows.applicationId, 'MSIX needs an application id');
  assert.equal(msix.windows.applicationId, 'CodeDesktopReconstruction');
  assert.notEqual(msix.windows.packageIdentity, ARTIFACT_IDENTITY.desktopName);
  assert.ok(msix.windows.capabilities.includes('runFullTrust'));

  const nsis = buildManifest(ROOT, { target: 'nsis' });
  assert.equal(nsis.windows.target, 'nsis');
  assert.equal(nsis.windows.perMachine, false, 'a reconstruction should not require elevation');
});

test('the ship list resolves against the real tree', () => {
  const { present, missing } = resolveShipList(ROOT);
  assert.deepEqual(missing, [], `missing ship entries: ${missing.join(', ')}`);
  assert.ok(present.includes('desktop'));
  assert.ok(present.includes('renderer'));
  assert.ok(present.includes('server.mjs'));
});

test('verifyBuild detects a missing required entry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pkg-'));
  try {
    const result = verifyBuild(dir, { expectFiles: ['server.mjs'] });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(' '), /missing: server\.mjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyBuild detects an excluded path that leaked in', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pkg-'));
  try {
    mkdirSync(path.join(dir, 'test'), { recursive: true });
    writeFileSync(path.join(dir, 'test', 'spec.mjs'), 'x');
    const result = verifyBuild(dir, { expectFiles: [] });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(' '), /excluded path present: test/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyBuild detects a stray probe file at the root', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pkg-'));
  try {
    writeFileSync(path.join(dir, 'probe-icons.cjs'), 'x');
    const result = verifyBuild(dir, { expectFiles: [] });
    assert.equal(result.ok, false);
    assert.match(result.problems.join(' '), /probe-icons\.cjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyBuild passes a clean tree', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pkg-'));
  try {
    writeFileSync(path.join(dir, 'server.mjs'), 'x');
    const result = verifyBuild(dir, { expectFiles: ['server.mjs'] });
    assert.deepEqual(result, { ok: true, problems: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the exclude list covers the source-only trees', () => {
  for (const entry of ['test', 'evidence', 'ccd-ref']) {
    assert.ok(EXCLUDE.includes(entry), `${entry} must be excluded`);
  }
  assert.ok(EXCLUDE.some(entry => entry.startsWith('probe-')), 'scratch probes must be excluded');
});

test('parseArgs defaults to a directory build', () => {
  const args = parseArgs([]);
  assert.equal(args.target, 'dir');
  assert.ok(args.out.endsWith('dist'));
});

test('parseArgs reads target and out', () => {
  const args = parseArgs(['--target', 'asar', '--out', '/tmp/x']);
  assert.equal(args.target, 'asar');
  assert.equal(args.out, path.resolve('/tmp/x'));
});

test('parseArgs refuses an unknown flag', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('the distributed runtime uses the application executable name', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'runtime-stage-'));
  try {
    const exe = stageRuntime(out);
    assert.ok(existsSync(exe));
    assert.equal(path.basename(exe), process.platform === 'win32' ? 'CodeDesktop-Reconstruction.exe' : 'code-desktop-reconstruction');
    assert.equal(existsSync(path.join(out, process.platform === 'win32' ? 'electron.exe' : 'electron')), false);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('runtime backup filtering keeps current assets and excludes historical copies', () => {
  for (const file of ['assets/page.js.bak', 'assets/page.js.bak-r645', 'assets/page.js.bak.old', 'page.js.sync-tmp']) assert.equal(isRuntimeBackup(file), true, file);
  for (const file of ['assets/page.js', 'desktop/backup-service.cjs', 'assets/bakery.js']) assert.equal(isRuntimeBackup(file), false, file);
});

test('staging produces a manifest describing the staged layout', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'stage-'));
  try {
    const appDir = stage(out);
    const manifest = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    assert.equal(manifest.main, 'desktop/main.cjs');
    assert.equal(manifest.private, true);
    assert.equal(manifest.devDependencies, undefined, 'devDependencies must not ship');
    assert.equal(manifest.scripts, undefined, 'source scripts must not ship');
    assert.ok(existsSync(path.join(appDir, 'desktop', 'main.cjs')));
    assert.ok(existsSync(path.join(appDir, 'renderer', 'index.html')));
    assert.ok(existsSync(path.join(appDir, 'server.mjs')));
    assert.ok(existsSync(path.join(appDir, 'resources', 'ion-dist', 'index.html')), 'the real frontend must ship');
    assert.ok(existsSync(path.join(appDir, 'resources', 'i18n-overlay', 'zh-Hans.json')), 'the locale catalog must ship');
    const bootstrap = require(path.join(appDir, 'desktop', 'bootstrap-service.cjs')).buildBootstrap();
    assert.ok(Object.keys(bootstrap.growthbook.features).length > 0, 'packaged bootstrap must retain captured feature contracts');
    assert.ok(!existsSync(path.join(appDir, 'test')), 'test must not be staged');
    assert.ok(!existsSync(path.join(appDir, 'evidence')), 'evidence must not be staged');
    const stagedFiles = require('../build/asar.cjs').collectFiles(appDir, ['desktop', 'renderer', 'resources']);
    assert.deepEqual(stagedFiles.filter(isRuntimeBackup), [], 'historical backups must not ship');
  } finally { rmSync(out, { recursive: true, force: true }); }
});
