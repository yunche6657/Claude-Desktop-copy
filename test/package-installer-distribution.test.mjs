import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createInstallerConfig, parseArgs, verifyInstaller } = require('../tools/package-installer.cjs');
const { packAsar } = require('../build/build.cjs');
const { createAsar } = require('../build/asar.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-distribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'test.ico'), Buffer.from([0, 0, 1, 0, 1, 0]));
  return root;
}

test('installer consumes only sanitized staged app and pinned external CCB, edits icons without signing', t => {
  const root = fixture(t);
  const config = createInstallerConfig({ directories: { buildResources: 'build' }, extraResources: [{ from: 'agent-core' }], win: { signAndEditExecutable: false }, nsis: { perMachine: false } }, root, 'test.ico');
  assert.equal(config.directories.app, 'dist-asar/resources/app');
  assert.deepEqual(config.files, ['**/*']);
  assert.deepEqual(config.extraResources, [{ from: 'dist-asar/resources/agent-core', to: 'agent-core', filter: ['**/*'] }]);
  assert.equal(config.win.signAndEditExecutable, true);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.win.icon, path.join(root, 'test.ico'));
  assert.equal(config.nsis.installerIcon, config.win.icon);
  assert.equal(config.nsis.uninstallerIcon, config.win.icon);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.electronDist, path.join(root, 'electron-runtime'));
});

test('local Electron staging excludes foreign application resources without modifying the source', t => {
  const root = fixture(t);
  const source = path.join(root, 'node_modules', 'electron', 'dist');
  fs.mkdirSync(path.join(source, 'resources', 'ion-dist'), { recursive: true });
  for (const file of ['electron.exe', 'resources/default_app.asar', 'resources/cowork-svc.exe', 'resources/ion-dist/old.js']) fs.writeFileSync(path.join(source, file), 'fixture');
  const output = require('../tools/package-installer.cjs').stageElectronRuntime(root);
  assert.ok(fs.existsSync(path.join(output, 'electron.exe')));
  assert.deepEqual(fs.readdirSync(path.join(output, 'resources')), ['default_app.asar']);
  assert.ok(fs.existsSync(path.join(source, 'resources', 'ion-dist', 'old.js')));
});

test('missing or non-ICO icon fails before invoking builder', t => {
  const root = fixture(t);
  assert.throws(() => createInstallerConfig({}, root), /icon is required/);
  fs.writeFileSync(path.join(root, 'bad.ico'), 'not an icon');
  assert.throws(() => createInstallerConfig({}, root, 'bad.ico'), /valid ICO/);
  assert.throws(() => parseArgs(['--icon']), /requires an ICO/);
  assert.throws(() => parseArgs(['--stage']), /requires a directory/);
});

test('verification detects private state and builder drift against the fresh whitelist asar', t => {
  const root = fixture(t);
  const installer = path.join(root, 'setup.exe');
  fs.writeFileSync(installer, 'stub');
  const resources = path.join(root, 'resources');
  fs.mkdirSync(resources);
  fs.writeFileSync(path.join(root, 'main.cjs'), 'clean');
  const expected = path.join(root, 'expected.asar');
  createAsar(root, ['main.cjs'], { outFile: expected });
  fs.writeFileSync(path.join(root, 'main.cjs'), 'changed');
  fs.mkdirSync(path.join(root, '.data'));
  fs.writeFileSync(path.join(root, '.data', 'auth.json'), 'synthetic-secret');
  const actual = path.join(resources, 'app.asar');
  createAsar(root, ['main.cjs', '.data/auth.json'], { outFile: actual });
  fs.writeFileSync(path.join(resources, 'foreign-service.exe'), 'fixture');
  const result = verifyInstaller(installer, actual, expected);
  assert.ok(result.problems.includes('unexpected external resource: foreign-service.exe'));
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(problem => /differs from the freshly built whitelist/.test(problem)));
  assert.ok(result.problems.some(problem => /private state path/.test(problem)));
  assert.ok(result.problems.some(problem => /CCB payload verification failed/.test(problem)));
});

test('keep-app preserves the sanitized app for builder while producing a fresh asar', t => {
  const root = fixture(t);
  const app = path.join(root, 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{"main":"desktop/main.cjs"}');
  const result = packAsar(root, { keepApp: true });
  assert.equal(result.fileCount, 1);
  assert.equal(fs.existsSync(path.join(app, 'package.json')), true);
  assert.equal(fs.existsSync(result.outFile), true);
  packAsar(root);
  assert.equal(fs.existsSync(app), false);
});
