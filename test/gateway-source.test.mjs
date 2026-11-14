// The settings banner must not tell the user to repair a provider that works.
//
// Measured 2026-10-23 on this host: configLibrary had `{"entries": []}` and one profile with
// no gateway fields, while ~/.claude/settings.json held a working ANTHROPIC_BASE_URL. The
// UI showed "Your provider setup needs a fix / Some required fields are missing or
// malformed" at the same time the launcher was completing turns with that same gateway.
//
// These tests pin the resolution chain that makes the banner honest, and pin that the
// bridge consumes it rather than keeping its own copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveGateway, synthesizeProfile, normaliseProfile, profileFiles } = require('../desktop/gateway-source.cjs');

function sandbox({ library, settings, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-source-'));
  const localAppData = path.join(dir, 'LocalAppData');
  const userProfile = path.join(dir, 'profile');
  fs.mkdirSync(path.join(userProfile, '.claude'), { recursive: true });
  if (library) {
    const lib = path.join(localAppData, 'Claude-3p', 'configLibrary');
    fs.mkdirSync(lib, { recursive: true });
    for (const [name, body] of Object.entries(library)) {
      fs.writeFileSync(path.join(lib, name), JSON.stringify(body, null, 2));
    }
  }
  if (settings) {
    fs.writeFileSync(path.join(userProfile, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  }
  return {
    LOCALAPPDATA: localAppData,
    APPDATA: path.join(dir, 'AppData'),
    USERPROFILE: userProfile,
    ...env,
  };
}

test('replica library takes precedence over official sealed credentials', () => {
  const env=sandbox({library:{'p1.json':{inferenceGatewayBaseUrl:'https://official.test',inferenceGatewayApiKey:'__sealed__:v1:opaque'}}});
  const dir=path.join(env.LOCALAPPDATA,'CodeDesktop-Reconstruction','configLibrary');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'_meta.json'),JSON.stringify({appliedId:'replica',entries:[{id:'replica'}]}));
  fs.writeFileSync(path.join(dir,'replica.json'),JSON.stringify({inferenceGatewayBaseUrl:'https://replica.test',inferenceGatewayApiKey:'fixture-key'}));
  const result=resolveGateway(env);assert.equal(result.baseUrl,'https://replica.test');assert.equal(result.apiKey,'fixture-key');
});

test('the applied profile wins over everything else', () => {
  const env = sandbox({
    library: {
      '_meta.json': { entries: [{ id: 'p1', name: 'CC Switch' }], appliedId: 'p1' },
      'p1.json': { inferenceGatewayBaseUrl: 'https://applied.example', inferenceGatewayApiKey: 'k1' },
      'p2.json': { inferenceGatewayBaseUrl: 'https://other.example' },
    },
    settings: { env: { ANTHROPIC_BASE_URL: 'https://settings.example' } },
  });
  const resolved = resolveGateway(env);
  assert.equal(resolved.baseUrl, 'https://applied.example');
  assert.equal(resolved.source, 'configLibrary');
});

test('an empty profile list is not the end of the search', () => {
  const env = sandbox({
    library: {
      '_meta.json': { entries: [] },
      '00000000-0000-4000-8000-000000157210.json': { coworkEgressAllowedHosts: ['*'], disableDeploymentModeChooser: true },
    },
    settings: { env: { ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_AUTH_TOKEN: 'k' } },
  });
  const resolved = resolveGateway(env);
  assert.equal(resolved.baseUrl, 'https://settings.example');
  assert.equal(resolved.source, 'claude-settings');
});

test('the environment is the last resort', () => {
  const env = sandbox({ env: { ANTHROPIC_BASE_URL: 'https://env.example', ANTHROPIC_AUTH_TOKEN: 'k' } });
  assert.equal(resolveGateway(env).source, 'environment');
});

test('with nothing configured the answer is an explicit empty record', () => {
  const env = sandbox({});
  const resolved = resolveGateway(env);
  assert.equal(resolved.baseUrl, '');
  assert.equal(resolved.source, 'none');
});

test('a resolved gateway is presented as a profile, so the settings form has fields', () => {
  const profile = synthesizeProfile({ baseUrl: 'https://settings.example', apiKey: 'k', model: '', provider: '', source: 'claude-settings', file: 'X' });
  assert.ok(profile);
  assert.equal(profile.config.inferenceGatewayBaseUrl, 'https://settings.example');
  assert.equal(profile.config.inferenceProvider, 'gateway');
  assert.equal(profile.config.resolvedFrom, 'claude-settings');
  assert.match(profile.name, /Claude settings/);
});

test('nothing resolved means no synthesized profile, rather than a fake one', () => {
  assert.equal(synthesizeProfile({ baseUrl: '', source: 'none' }), null);
  assert.equal(synthesizeProfile(null), null);
});

test('profile files are ordered applied -> listed -> remaining, never by raw readdir order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-order-'));
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ entries: [{ id: 'listed' }], appliedId: 'applied' }));
  for (const id of ['zzz', 'applied', 'listed', 'aaa']) {
    fs.writeFileSync(path.join(dir, id + '.json'), '{}');
  }
  const order = profileFiles(dir).map((file) => path.basename(file, '.json'));
  assert.equal(order[0], 'applied');
  assert.equal(order[1], 'listed');
  assert.deepEqual(order.slice(2), ['aaa', 'zzz']);
});

test('a nested credentials object is understood', () => {
  const normalised = normaliseProfile({ credentials: { baseUrl: 'https://nested.example', accessToken: 'tok' } });
  assert.equal(normalised.baseUrl, 'https://nested.example');
  assert.equal(normalised.apiKey, 'tok');
});

test('the bridge asks the shared resolver instead of keeping its own copy', () => {
  const source = fs.readFileSync(new URL('../desktop/bridge-services.cjs', import.meta.url), 'utf8');
  assert.match(source, /require\('\.\/gateway-source\.cjs'\)/, 'the bridge must use the shared resolver');
  assert.match(source, /synthesizeProfile\(resolveGateway\(\)\)/, 'read3pConfig must fall back to the resolver');
});

test('the launcher and the bridge agree, because both go through the same chain', () => {
  const launcher = fs.readFileSync(new URL('../tools/gateway-config.cjs', import.meta.url), 'utf8');
  // The launcher keeps its own field names (inferenceGatewayBaseUrl) but must implement the
  // same precedence: settings.json is consulted, not just configLibrary.
  assert.match(launcher, /claude-settings/, 'the launcher must include the settings.json source');
  assert.match(launcher, /readdirSync/, 'the launcher must still read configLibrary');
});
