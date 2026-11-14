import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prepareDistributionWorkspace } = require('../desktop/distribution-workspace.cjs');
const { configLibraryDirs, resolveGateway } = require('../desktop/gateway-source.cjs');
const unexpected = () => assert.fail('unexpected filesystem or appData access');

test('development launches keep the existing workspace selection without creating directories', () => {
  for (const env of [{}, { CLAUDE_WORKSPACE: 'explicit-development-workspace' }]) {
    const before = { ...env };
    assert.equal(prepareDistributionWorkspace({ app: { isPackaged: false, getPath: unexpected }, env, mkdir: unexpected }), env.CLAUDE_WORKSPACE || null);
    assert.deepEqual(env, before);
  }
});

test('an absent app leaves the environment untouched', () => {
  const env = {};
  assert.equal(prepareDistributionWorkspace({ env, mkdir: unexpected }), null);
  assert.deepEqual(env, {});
});

test('packaged launches preserve an explicit workspace while isolating configuration', () => {
  const env = { LOCALAPPDATA: os.tmpdir(), CLAUDE_WORKSPACE: 'explicit-packaged-workspace' };
  const created = [];
  assert.equal(prepareDistributionWorkspace({ app: { isPackaged: true, getPath: unexpected }, env, mkdir: dir => created.push(dir) }), 'explicit-packaged-workspace');
  assert.equal(env.CLAUDE_WORKSPACE, 'explicit-packaged-workspace');
  assert.equal(env.CLAUDE_RECONSTRUCTION_CONFIG_DIR, path.join(env.LOCALAPPDATA, 'CodeDesktop-Reconstruction', 'configLibrary'));
  assert.deepEqual(created, [env.CLAUDE_WORKSPACE, env.CLAUDE_RECONSTRUCTION_CONFIG_DIR]);
});

test('packaged launches initialize workspace and isolated config under LOCALAPPDATA', () => {
  const env = { LOCALAPPDATA: path.join(os.tmpdir(), 'distribution-local-app-data') };
  const created = [];
  const workspace = path.join(env.LOCALAPPDATA, 'CodeDesktop-Reconstruction', 'workspace');
  const config = path.join(env.LOCALAPPDATA, 'CodeDesktop-Reconstruction', 'configLibrary');
  assert.equal(prepareDistributionWorkspace({ app: { isPackaged: true, getPath: unexpected }, env, mkdir: dir => created.push(dir) }), workspace);
  assert.deepEqual(created, [workspace, config]);
  assert.equal(env.CLAUDE_WORKSPACE, workspace);
  assert.equal(env.CLAUDE_RECONSTRUCTION_CONFIG_DIR, config);
});

test('missing LOCALAPPDATA falls back to Electron appData', () => {
  for (const localAppData of [undefined, '']) {
    const env = { LOCALAPPDATA: localAppData };
    const base = path.join(os.tmpdir(), 'distribution-electron-app-data');
    const requested = [];
    const created = [];
    const result = prepareDistributionWorkspace({
      app: { isPackaged: true, getPath: name => { requested.push(name); return base; } },
      env, mkdir: dir => created.push(dir),
    });
    assert.deepEqual(requested, ['appData']);
    assert.equal(result, path.join(base, 'CodeDesktop-Reconstruction', 'workspace'));
    assert.deepEqual(created, [result, path.join(base, 'CodeDesktop-Reconstruction', 'configLibrary')]);
  }
});

test('an explicit reconstruction config directory is preserved', () => {
  const env = { LOCALAPPDATA: os.tmpdir(), CLAUDE_RECONSTRUCTION_CONFIG_DIR: path.join(os.tmpdir(), 'custom-distribution-config') };
  const expected = env.CLAUDE_RECONSTRUCTION_CONFIG_DIR;
  prepareDistributionWorkspace({ app: { isPackaged: true }, env, mkdir: () => {} });
  assert.equal(env.CLAUDE_RECONSTRUCTION_CONFIG_DIR, expected);
  assert.deepEqual(configLibraryDirs(env), [expected]);
});

test('preparing an initialized packaged workspace is idempotent', () => {
  const env = { LOCALAPPDATA: os.tmpdir() };
  const created = [];
  const options = { app: { isPackaged: true }, env, mkdir: dir => created.push(dir) };
  const result = prepareDistributionWorkspace(options);
  const before = { ...env };
  assert.equal(prepareDistributionWorkspace(options), result);
  assert.deepEqual(env, before);
  assert.deepEqual(created, [result, env.CLAUDE_RECONSTRUCTION_CONFIG_DIR, result, env.CLAUDE_RECONSTRUCTION_CONFIG_DIR]);
});

test('mkdir failures propagate before publishing a workspace', () => {
  const env = { LOCALAPPDATA: os.tmpdir() };
  const failure = Object.assign(new Error('fixture directory creation failed'), { code: 'EACCES' });
  assert.throws(() => prepareDistributionWorkspace({ app: { isPackaged: true }, env, mkdir: () => { throw failure; } }), error => error === failure);
  assert.equal(env.CLAUDE_WORKSPACE, undefined);
  assert.equal(env.CLAUDE_RECONSTRUCTION_CONFIG_DIR, undefined);
});

test('default mkdir creates real directories and a clean packaged config excludes official sealed profiles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'distribution-workspace-'));
  // Only this test-owned, absolute temporary directory is removed.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { LOCALAPPDATA: path.join(root, 'local'), USERPROFILE: path.join(root, 'user') };
  const official = path.join(env.LOCALAPPDATA, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(official, { recursive: true });
  fs.writeFileSync(path.join(official, 'official.json'), JSON.stringify({ inferenceGatewayBaseUrl: 'https://official.invalid', inferenceGatewayApiKey: '__sealed__:fixture' }));
  const settingsDir = path.join(env.USERPROFILE, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://settings.invalid', ANTHROPIC_AUTH_TOKEN: 'settings-fixture' } }));
  assert.equal(resolveGateway(env).apiKey, '__sealed__:fixture', 'fixture reproduces the original fallback before preparation');
  const workspace = prepareDistributionWorkspace({ app: { isPackaged: true }, env });
  assert.ok(fs.statSync(workspace).isDirectory());
  assert.ok(fs.statSync(env.CLAUDE_RECONSTRUCTION_CONFIG_DIR).isDirectory());
  assert.deepEqual(configLibraryDirs(env), [env.CLAUDE_RECONSTRUCTION_CONFIG_DIR]);
  assert.equal(resolveGateway(env).source, 'none');
  assert.equal(resolveGateway(env).apiKey, '');
  env.ANTHROPIC_BASE_URL = 'https://explicit-env.invalid';
  env.ANTHROPIC_AUTH_TOKEN = 'environment-fixture';
  assert.equal(resolveGateway(env).source, 'environment');
  assert.equal(resolveGateway(env).apiKey, 'environment-fixture');
});
