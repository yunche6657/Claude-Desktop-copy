// The applied provider profile must actually drive the agent.
//
// Before this, `resolveConfig` read ONLY environment variables. Choosing a provider in the
// settings UI wrote the profile to disk (Custom3pSetup, round 71) and then changed nothing:
// the agent kept using whatever the environment said. This pins the profile -> agent path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveConfig, isConfigured } = require('../desktop/agent-config.cjs');

/** Build a temp config library and point LOCALAPPDATA at it. */
function withLibrary(profiles, appliedId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-agentcfg-'));
  const dir = path.join(root, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const p of profiles) {
    fs.writeFileSync(path.join(dir, `${p.id}.json`), JSON.stringify(p.body, null, 2));
    entries.push({ id: p.id, name: p.name || p.id });
  }
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({
    entries,
    appliedId: appliedId === undefined ? (entries[0] && entries[0].id) : appliedId,
  }, null, 2));
  return { root, dir };
}

test('the applied profile supplies baseUrl, key and model', () => {
  const { root } = withLibrary([{
    id: 'p1',
    body: {
      inferenceGatewayBaseUrl: 'https://gateway.example.com',
      inferenceGatewayApiKey: 'sk-profile-key',
      model: 'claude-sonnet-5-5',
    },
  }]);
  try {
    const cfg = resolveConfig({ LOCALAPPDATA: root });
    assert.equal(cfg.baseUrl, 'https://gateway.example.com');
    assert.equal(cfg.apiKey, 'sk-profile-key');
    assert.equal(cfg.model, 'claude-sonnet-5-5');
    assert.equal(cfg.source, 'profile', 'the UI needs to know where the values came from');
    assert.equal(cfg.profileId, 'p1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('environment variables still win over the profile', () => {
  // The launcher and every probe set ANTHROPIC_BASE_URL; if the profile won, they would
  // silently talk to a different endpoint.
  const { root } = withLibrary([{
    id: 'p1',
    body: { inferenceGatewayBaseUrl: 'https://profile.example.com', apiKey: 'k-profile', model: 'm-profile' },
  }]);
  try {
    const cfg = resolveConfig({
      LOCALAPPDATA: root,
      ANTHROPIC_BASE_URL: 'https://env.example.com',
      ANTHROPIC_AUTH_TOKEN: 'env-key',
      CLAUDE_AGENT_MODEL: 'env-model',
    });
    assert.equal(cfg.baseUrl, 'https://env.example.com');
    assert.equal(cfg.apiKey, 'env-key');
    assert.equal(cfg.model, 'env-model');
    assert.equal(cfg.source, 'env');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a partial profile only fills the gaps', () => {
  // A profile with only a key must not blank out the default base URL.
  const { root } = withLibrary([{ id: 'p1', body: { apiKey: 'only-key' } }]);
  try {
    const cfg = resolveConfig({ LOCALAPPDATA: root });
    assert.equal(cfg.apiKey, 'only-key');
    assert.equal(cfg.baseUrl, 'https://api.anthropic.com', 'must fall back to the default');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('credentials nested in the profile are read too', () => {
  // Profiles imported from an OAuth flow keep the token under `credentials`.
  const { root } = withLibrary([{
    id: 'p1',
    body: {
      type: 'oauth',
      credentials: { accessToken: 'oauth-access-token', baseUrl: 'https://oauth.example.com' },
      model: 'claude-opus-5',
    },
  }]);
  try {
    const cfg = resolveConfig({ LOCALAPPDATA: root });
    assert.equal(cfg.apiKey, 'oauth-access-token');
    assert.equal(cfg.baseUrl, 'https://oauth.example.com');
    assert.equal(cfg.model, 'claude-opus-5');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no library at all keeps the previous behaviour', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-agentcfg-empty-'));
  try {
    const cfg = resolveConfig({ LOCALAPPDATA: root });
    assert.equal(cfg.baseUrl, 'https://api.anthropic.com');
    assert.equal(cfg.apiKey, '');
    assert.equal(cfg.source, 'none');
    assert.equal(cfg.profileId, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt _meta.json does not throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-agentcfg-bad-'));
  const dir = path.join(root, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_meta.json'), '{ not json');
  try {
    const cfg = resolveConfig({ LOCALAPPDATA: root });
    assert.equal(cfg.source, 'none');
    assert.equal(cfg.baseUrl, 'https://api.anthropic.com');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('appliedId selects which profile is used', () => {
  // Two profiles exist; the applied one must be the one that takes effect.
  const { root } = withLibrary([
    { id: 'p1', body: { inferenceGatewayBaseUrl: 'https://first.example.com', apiKey: 'k1', model: 'm1' } },
    { id: 'p2', body: { inferenceGatewayBaseUrl: 'https://second.example.com', apiKey: 'k2', model: 'm2' } },
  ], 'p2');
  try {
    const cfg = resolveConfig({ LOCALAPPDATA: root });
    assert.equal(cfg.profileId, 'p2');
    assert.equal(cfg.baseUrl, 'https://second.example.com');
    assert.equal(cfg.apiKey, 'k2');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('isConfigured is true once a profile supplies key and model', () => {
  const { root } = withLibrary([{
    id: 'p1',
    body: { inferenceGatewayApiKey: 'k', model: 'claude-sonnet-5-5' },
  }]);
  try {
    assert.equal(isConfigured({ LOCALAPPDATA: root }), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('isConfigured stays false without a key', () => {
  const { root } = withLibrary([{ id: 'p1', body: { model: 'm' } }]);
  try {
    assert.equal(isConfigured({ LOCALAPPDATA: root }), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('explicit foreign endpoint cannot inherit the old profile credential, model or permission mode', () => {
  const { root } = withLibrary([{ id:'old-target',body:{inferenceGatewayBaseUrl:'https://old.example/v1',inferenceGatewayApiKey:'old-target-secret',model:'old-model',permissionMode:'auto'} }]);
  try {
    const cfg = resolveConfig({ LOCALAPPDATA:root, ANTHROPIC_BASE_URL:'https://new.example/v1' });
    assert.equal(cfg.apiKey,''); assert.equal(cfg.model,''); assert.equal(cfg.profileId,null); assert.equal(cfg.source,'none'); assert.equal(cfg.permissionMode,'ask');
    const same=resolveConfig({LOCALAPPDATA:root,ANTHROPIC_BASE_URL:'https://old.example/v1/'});
    assert.equal(same.apiKey,'old-target-secret'); assert.equal(same.model,'old-model');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
