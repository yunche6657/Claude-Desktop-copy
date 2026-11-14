import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveGateway, normaliseProfile } = require('../desktop/gateway-source.cjs');
const { applyStartupDefaults } = require('../desktop/startup-defaults.cjs');

test('invalid persisted API type leaves first startup available for configuration repair', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-invalid-profile-'));
  try {
    const dir = path.join(root, 'configLibrary');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ appliedId: 'old', entries: [{ id: 'old' }] }));
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ inferenceGatewayBaseUrl: 'https://fixture.test', inferenceApiType: 'obsolete-api' }));
    const env = { CLAUDE_RECONSTRUCTION_CONFIG_DIR: dir, USERPROFILE: root };
    assert.equal(resolveGateway(env).source, 'none');
    assert.doesNotThrow(() => applyStartupDefaults(env));
    assert.equal(env.CLAUDE_VIEW, 'frontend');
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.throws(() => normaliseProfile({ inferenceApiType: 'obsolete-api' }), /Unsupported inferenceApiType/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid API types in CLI settings and environment do not prevent opening settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-invalid-env-'));
  try {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://fixture.test', ANTHROPIC_API_TYPE: 'obsolete-api' } }));
    const env = { USERPROFILE: root, ANTHROPIC_BASE_URL: 'https://fixture.test', ANTHROPIC_API_TYPE: 'obsolete-api' };
    assert.equal(resolveGateway(env).source, 'none');
    assert.doesNotThrow(() => applyStartupDefaults(env));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
