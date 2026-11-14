import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveAgentCorePayload } = require('../build/packaging.cjs');
const { stageAgentCore } = require('../build/build.cjs');
const hash = contents => crypto.createHash('sha256').update(contents).digest('hex');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packaging-ccb-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const core = path.join(source, 'agent-core');
  const bundle = path.join(core, 'claude-code', 'dist');
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(path.join(core, 'bun'), { recursive: true });
  const entries = { 'cli-bun.js': 'import "./chunk.js";', 'chunk.js': 'export const value=1;' };
  const digest = crypto.createHash('sha256');
  for (const name of Object.keys(entries).sort()) {
    fs.writeFileSync(path.join(bundle, name), entries[name]);
    digest.update(name + '\u0000').update(hash(entries[name])).update('\n');
  }
  fs.writeFileSync(path.join(core, 'bun', 'bun.exe'), 'fixture executable');
  const manifest = {
    agentCore: 'claude-code-best', upstream: 'https://example.test/pinned', pinnedCommit: 'fixture-pin', version: '2.8.4',
    sourceRoot: 'C:/private/build-path', credentials: { apiKey: 'synthetic-must-not-ship' },
    bun: { path: 'agent-core/bun/bun.exe', version: 'fixture', sha256: hash('fixture executable'), settings: 'private' },
    bundle: { entry: 'claude-code/dist/cli-bun.js', entrySha256: hash(entries['cli-bun.js']), fileCount: 2,
      totalBytes: Object.values(entries).reduce((sum, value) => sum + Buffer.byteLength(value), 0), treeSha256: digest.digest('hex') },
  };
  const manifestFile = path.join(core, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return { source, core, bundle, manifest, manifestFile, output: path.join(directory, 'output') };
}

test('ships only pinned external payload, strips local metadata, and removes stale output', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.core, 'claude-code', '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(f.core, 'claude-code', '.tmp', 'settings.json'), 'synthetic-private');
  fs.writeFileSync(path.join(f.core, 'settings.json'), 'synthetic-private');
  fs.writeFileSync(path.join(f.core, 'bun', 'debug.log'), 'synthetic-private');
  fs.mkdirSync(path.join(f.output, 'resources', 'agent-core'), { recursive: true });
  fs.writeFileSync(path.join(f.output, 'resources', 'agent-core', 'old-settings.json'), 'synthetic-private');
  const report = stageAgentCore(f.output, { rootDir: f.source });
  const deployed = path.join(f.output, 'resources', 'agent-core');
  assert.equal(report.files, 4);
  assert.equal(report.version, '2.8.4');
  assert.equal(fs.existsSync(path.join(deployed, 'bun', 'bun.exe')), true);
  assert.equal(fs.existsSync(path.join(deployed, 'claude-code', 'dist', 'cli-bun.js')), true);
  for (const file of ['settings.json', 'old-settings.json', 'bun/debug.log', 'claude-code/.tmp'])
    assert.equal(fs.existsSync(path.join(deployed, file)), false, file);
  const published = JSON.parse(fs.readFileSync(path.join(deployed, 'manifest.json'), 'utf8'));
  assert.equal(published.sourceRoot, undefined);
  assert.equal(published.credentials, undefined);
  assert.equal(published.bun.settings, undefined);
  assert.deepEqual(Object.keys(published.bun).sort(), ['path', 'sha256', 'version']);
  assert.deepEqual(Object.keys(published.bundle).sort(), ['entry', 'entrySha256', 'fileCount', 'totalBytes', 'treeSha256']);
  assert.equal(resolveAgentCorePayload(path.join(f.output, 'resources')).manifest.bundle.treeSha256, f.manifest.bundle.treeSha256);
  assert.equal(fs.existsSync(path.join(f.output, 'resources', 'app', 'agent-core')), false);
});

test('Bun drift refuses packaging before replacing a previous external payload', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.core, 'bun', 'bun.exe'), 'modified executable');
  assert.throws(() => stageAgentCore(f.output, { rootDir: f.source }), /Bun SHA256/);
  assert.equal(fs.existsSync(f.output), false);
});

test('new settings or a modified chunk inside dist fails the pinned tree digest', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundle, 'settings.json'), 'synthetic-private');
  assert.throws(() => resolveAgentCorePayload(f.source), /bundle differs/);
  fs.unlinkSync(path.join(f.bundle, 'settings.json'));
  fs.writeFileSync(path.join(f.bundle, 'chunk.js'), 'export const value=2;');
  assert.throws(() => resolveAgentCorePayload(f.source), /bundle differs/);
});

test('manifest cannot redirect native executable or entry into arbitrary files', t => {
  const f = fixture(t);
  f.manifest.bun.path = '../../private.exe';
  fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
  assert.throws(() => resolveAgentCorePayload(f.source), /pin layout/);
});

test('digest metadata must be present and valid', t => {
  const f = fixture(t);
  delete f.manifest.bundle.treeSha256;
  fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
  assert.throws(() => resolveAgentCorePayload(f.source), /pin digest/);
});

test('symlinked bundle cannot import unpinned external content', t => {
  const f = fixture(t);
  fs.symlinkSync(path.dirname(f.bundle), path.join(f.bundle, 'external'), 'junction');
  assert.throws(() => resolveAgentCorePayload(f.source), /symbolic link/);
});
