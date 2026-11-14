// The launcher must always be able to find a gateway.
//
// On 2026-10-23 the shipped app's configLibrary on this host had `{"entries": []}`, and the
// launcher silently started the replica with no gateway at all: every turn failed with
// "agent mode needs ANTHROPIC_AUTH_TOKEN". These tests pin the fallback chain so an empty
// profile list degrades to the next source instead of to an outage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readGatewayConfig, normalise } = require('../tools/gateway-config.cjs');

/** A throwaway home + appdata pair so tests never read the real ones. */
function sandbox({ library, settings } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-config-'));
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
  return { env: { LOCALAPPDATA: localAppData, APPDATA: path.join(dir, 'AppData'), USERPROFILE: userProfile }, dir };
}

test('the applied profile in configLibrary wins', () => {
  const { env } = sandbox({
    library: {
      '_meta.json': { entries: [{ id: 'p1', name: 'CC Switch' }], appliedId: 'p1' },
      'p1.json': { inferenceGatewayBaseUrl: 'https://applied.example', inferenceGatewayApiKey: 'k1' },
      'p2.json': { inferenceGatewayBaseUrl: 'https://other.example', inferenceGatewayApiKey: 'k2' },
    },
    settings: { env: { ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_AUTH_TOKEN: 'k3' } },
  });
  const config = readGatewayConfig(env);
  assert.equal(config.baseUrl, 'https://applied.example');
  assert.equal(config.apiKey, 'k1');
  assert.equal(config.source, 'configLibrary');
});

test('an empty applied profile list falls back to ~/.claude/settings.json', () => {
  // This is the exact shape measured on this host: _meta.json with entries: [] plus a
  // stray profile that carries no gateway keys.
  const { env } = sandbox({
    library: {
      '_meta.json': { entries: [] },
      '00000000-0000-4000-8000-000000157210.json': { coworkEgressAllowedHosts: ['*'] },
    },
    settings: { env: { ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_AUTH_TOKEN: 'k3' } },
  });
  const config = readGatewayConfig(env);
  assert.equal(config.baseUrl, 'https://settings.example');
  assert.equal(config.apiKey, 'k3');
  assert.equal(config.source, 'claude-settings');
});

test('a profile that carries no gateway keys is skipped, not treated as an answer', () => {
  const { env } = sandbox({
    library: { '_meta.json': { entries: [] }, 'empty.json': { theme: 'dark' } },
    settings: { env: { ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_AUTH_TOKEN: 'k3' } },
  });
  assert.equal(readGatewayConfig(env).baseUrl, 'https://settings.example');
});

test('the environment is the last resort, never the first', () => {
  const { env } = sandbox({ settings: { env: { ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_AUTH_TOKEN: 'k3' } } });
  const config = readGatewayConfig({ ...env, ANTHROPIC_BASE_URL: 'https://env.example', ANTHROPIC_AUTH_TOKEN: 'k4' });
  assert.equal(config.baseUrl, 'https://settings.example', 'a file on disk outranks the ambient shell');
});

test('with nothing anywhere the answer is an explicit empty source, not a throw', () => {
  const { env } = sandbox({});
  const config = readGatewayConfig(env);
  assert.equal(config.baseUrl, '');
  assert.equal(config.apiKey, '');
  assert.equal(config.source, 'none');
});

test('both spellings of each field are the same value', () => {
  const { env } = sandbox({ settings: { env: { ANTHROPIC_BASE_URL: 'https://settings.example', ANTHROPIC_AUTH_TOKEN: 'k3' } } });
  const config = readGatewayConfig(env);
  assert.equal(config.inferenceGatewayBaseUrl, config.baseUrl);
  assert.equal(config.inferenceGatewayApiKey, config.apiKey);
});

test('a nested credentials object is understood as well as flat keys', () => {
  assert.deepEqual(
    (({ baseUrl, apiKey }) => ({ baseUrl, apiKey }))(normalise({ credentials: { baseUrl: 'https://nested.example', accessToken: 'tok' } })),
    { baseUrl: 'https://nested.example', apiKey: 'tok' },
  );
});

test('the launcher really reads the resolved values rather than its own copy', () => {
  const source = fs.readFileSync(new URL('../tools/launch-replica.cjs', import.meta.url), 'utf8');
  assert.match(source, /applyStartupDefaults\(env\)/, 'the launcher must use executable startup configuration');
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{20,}/, 'no key may be hard-coded in the launcher');
});
