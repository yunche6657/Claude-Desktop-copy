// The CCB child must be told the gateway, and must be told the model.
//
// Two independent config channels, and getting either wrong makes every turn fail in a way
// that looks like a gateway outage:
//
//   1. ENDPOINT. The kernel merges ~/.claude/settings.json env into process.env, and a settings
//      value WINS over the inherited environment. On this host that file pins ANTHROPIC_BASE_URL
//      to a different gateway, so passing ANTHROPIC_BASE_URL to the child did nothing at all —
//      a local logging proxy received zero requests. --settings is the higher-precedence channel.
//   2. MODEL. The kernel picks its model from --model / ANTHROPIC_MODEL, separately from the
//      endpoint. Left alone it requests a Claude id, which a non-Anthropic gateway does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'desktop', 'ccb-kernel.cjs'), 'utf8');

test('the gateway is injected via --settings, not only through the environment', () => {
  assert.match(source, /writeGatewaySettings/, 'a settings file must be written');
  assert.match(source, /'--settings'/, 'and passed to the child');
  // The env-only path is exactly what failed: settings.json outranks inherited env.
  assert.match(source, /ANTHROPIC_BASE_URL: baseUrl/, 'the settings file carries the base URL');
  assert.doesNotMatch(source, /ANTHROPIC_AUTH_TOKEN: token/, 'credentials remain in the child environment, not the settings file');
});

test('the resolved model is passed as --model and ANTHROPIC_MODEL', () => {
  assert.match(source, /args\.push\('--model', model\)/, 'the flag the kernel reads');
  assert.match(source, /ANTHROPIC_MODEL/, 'and the env var it also reads');
});

test('buildArgs receives the session state, so the settings file can be per-session', () => {
  // A global settings file would make two sessions with different gateways fight.
  assert.match(source, /function buildArgs\(state\)/);
  assert.match(source, /buildArgs\(state\)/);
});

test('the settings file is written under the session scratch dir', () => {
  assert.match(source, /kernel-settings-/, 'one file per session');
});

test('main.cjs passes the gateway model into the CCB backend', () => {
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  const at = main.indexOf('function createCcbBackend(');
  const section = main.slice(at, main.indexOf('// The boot-feature map', at));
  assert.match(section, /model: process\.env\.CLAUDE_AGENT_MODEL \|\| process\.env\.ANTHROPIC_MODEL \|\| null/, 'the backend must use the canonical startup model');
  assert.doesNotMatch(section, /resolveGateway\(\)\.model/, 'a raw profile must not replace the selected startup model');
});
