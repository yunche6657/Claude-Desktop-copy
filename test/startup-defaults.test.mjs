import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { applyStartupDefaults } = require('../desktop/startup-defaults.cjs');
const resolved = { baseUrl: 'https://profile.example', apiKey: 'profile-key', model: 'profile-model' };
const noRuntime = () => ({});

test('direct executable leaves kernel selection to the native availability policy', () => {
  const env = applyStartupDefaults({}, () => resolved, noRuntime);
  assert.equal(env.CLAUDE_VIEW, 'frontend');
  assert.equal(env.CLAUDE_AGENT_KERNEL, undefined);
  assert.equal(env.MODE, 'agent');
  assert.equal(env.ANTHROPIC_BASE_URL, resolved.baseUrl);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, resolved.apiKey);
  assert.equal(env.CLAUDE_AGENT_MODEL, resolved.model);
});

test('explicit endpoint does not borrow another profile key or model', () => {
  const env = { ANTHROPIC_BASE_URL: 'https://other.example' };
  applyStartupDefaults(env, () => resolved, noRuntime);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_AGENT_MODEL, undefined);
});

test('same endpoint may supply omitted profile fields and explicit local remains authoritative', () => {
  const env = { ANTHROPIC_BASE_URL: 'https://profile.example/', CLAUDE_AGENT_KERNEL: 'local' };
  applyStartupDefaults(env, () => resolved, noRuntime);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'profile-key');
  assert.equal(env.CLAUDE_AGENT_MODEL, 'profile-model');
  assert.equal(env.CLAUDE_AGENT_KERNEL, 'local');
});

test('launcher and direct startup derive the same provider and model from an isolated active profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-profile-'));
  const dir = path.join(root, 'Claude-3p', 'configLibrary'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ entries: [{ id: 'fixture' }], appliedId: 'fixture' }));
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ inferenceGatewayBaseUrl: 'https://profile.example', inferenceGatewayApiKey: 'fixture-key', model: 'fixture-model' }));
  const env = { LOCALAPPDATA: root, APPDATA: root, USERPROFILE: root, HOME: root, CLAUDE_WORKSPACE: root };
  const direct = applyStartupDefaults({ ...env });
  const launched = require('../tools/launch-replica.cjs').buildLauncherEnv(env);
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_AGENT_MODEL', 'CLAUDE_AGENT_KERNEL']) assert.equal(launched[key], direct[key]);
  assert.equal(launched.CLAUDE_AGENT_MODEL, 'fixture-model');
  const override = { ...env, ANTHROPIC_BASE_URL: 'https://other.example' };
  const directOverride = applyStartupDefaults({ ...override });
  const launcherOverride = require('../tools/launch-replica.cjs').buildLauncherEnv(override);
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_AGENT_MODEL']) assert.equal(launcherOverride[key], directOverride[key]);
  assert.equal(launcherOverride.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(launcherOverride.CLAUDE_AGENT_MODEL, undefined);
});

test('a unique workspace runtime rule supplies a missing model to both entry points', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-runtime-'));
  const data = path.join(root, '.data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'gateway-runtime.json'), JSON.stringify({ version: 1, rules: [
    { baseURL: 'https://gateway.example', model: 'runtime-model', adapter: 'system-first' },
  ] }));
  const env = { LOCALAPPDATA: root, APPDATA: root, USERPROFILE: root, HOME: root,
    CLAUDE_WORKSPACE: root, ANTHROPIC_BASE_URL: 'https://gateway.example' };
  const direct = applyStartupDefaults({ ...env });
  const launched = require('../tools/launch-replica.cjs').buildLauncherEnv(env);
  assert.equal(direct.CLAUDE_AGENT_MODEL, 'runtime-model');
  assert.equal(launched.CLAUDE_AGENT_MODEL, direct.CLAUDE_AGENT_MODEL);
  assert.equal(applyStartupDefaults({ ...env, ANTHROPIC_MODEL: 'explicit-model' }).CLAUDE_AGENT_MODEL, 'explicit-model');
});

test('explicit launch choices and standard API key/model names stay authoritative', () => {
  const env = { CLAUDE_VIEW: 'handdrawn', CLAUDE_AGENT_KERNEL: 'ccb', MODE: 'demo', ANTHROPIC_BASE_URL: 'https://explicit.example', ANTHROPIC_API_KEY: 'explicit-key', ANTHROPIC_MODEL: 'explicit-model' };
  applyStartupDefaults(env, () => resolved, noRuntime);
  assert.equal(env.CLAUDE_VIEW, 'handdrawn');
  assert.equal(env.CLAUDE_AGENT_KERNEL, 'ccb');
  assert.equal(env.MODE, 'demo');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://explicit.example');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_AGENT_MODEL, 'explicit-model');
});
