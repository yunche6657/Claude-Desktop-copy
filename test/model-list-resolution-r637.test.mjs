// R637: the shipped settings UI writes `inferenceModels` (an array, first entry = default model); `agent-config.cjs` read only
// `profile.model` / `profile.defaultModel`, so a user who filled in Gateway base URL, API key AND a model still got
// "agent configuration incomplete". `inferenceModels` appeared zero times in that file.
//
// WHAT WAS MEASURED BEFORE THE FIX
//       UI field  "Model list"        → flatKey inferenceModels        (array; "First entry is the default")
//       UI field  "Gateway base URL"  → flatKey inferenceGatewayBaseUrl (read correctly)
//       UI field  "Gateway API key"   → flatKey inferenceGatewayApiKey  (read correctly)
//       resolver  model = pick(env.CLAUDE_AGENT_MODEL, env.ANTHROPIC_MODEL, profile.model, profile.defaultModel)
//       grep      inferenceModels in desktop/agent-config.cjs → 0 hits
//
//   So the gap was one key wide, and it is the key the UI actually writes.
//
// The UI list takes precedence over legacy scalar model/defaultModel fields retained by imports.
// Environment overrides retain priority. String entries and object entries ({id}, {model}, {name}) resolve.
// These tests use temporary configuration libraries; bridge creation/import has separate integration coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = require(path.join(ROOT, 'desktop', 'agent-config.cjs'));

/** Point resolveConfig at a throwaway configLibrary carrying the given profile. */
const withProfile = (profile, overrides = {}) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgprobe-r637-'));
  const lib = path.join(tmpRoot, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, '_meta.json'),
    JSON.stringify({ entries: [{ id: 'p1', name: 'probe' }], appliedId: 'p1' }));
  fs.writeFileSync(path.join(lib, 'p1.json'), JSON.stringify(profile));
  const env = { LOCALAPPDATA: tmpRoot, APPDATA: path.join(tmpRoot, 'roaming'), ...overrides };
  try {
    return { resolved: cfg.resolveConfig(env), cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }) };
  } catch (e) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw e;
  }
};

const BASE = {
  inferenceProvider: 'gateway',
  inferenceGatewayBaseUrl: 'https://gw.example.test',
  inferenceGatewayApiKey: 'sk-test-not-a-real-key',
};

test('inferenceModels resolves the first entry as the default model', () => {
  const { resolved, cleanup } = withProfile({ ...BASE, inferenceModels: ['model-from-list', 'model-second'] });
  try {
    assert.equal(resolved.model, 'model-from-list');
    assert.equal(resolved.baseUrl, 'https://gw.example.test');
    assert.equal(Boolean(resolved.apiKey && resolved.model), true, 'the profile still reports as unconfigured');
  } finally { cleanup(); }
});

test('an object-shaped inferenceModels entry resolves by id, model, or name', () => {
  for (const key of ['id', 'model', 'name']) {
    const { resolved, cleanup } = withProfile({ ...BASE, inferenceModels: [{ [key]: `obj-${key}` }] });
    try {
      assert.equal(resolved.model, `obj-${key}`, `object form with ${key} did not resolve`);
    } finally { cleanup(); }
  }
});

test('the UI list wins over stale imported scalar model fields', () => {
  const { resolved, cleanup } = withProfile({
    ...BASE, model: 'old-model', defaultModel: 'old-default', inferenceModels: ['ui-default', 'ui-second'],
  });
  try {
    assert.equal(resolved.model, 'ui-default');
  } finally { cleanup(); }
});

test('environment overrides still win over the UI list', () => {
  for (const overrides of [
    { CLAUDE_AGENT_MODEL: 'agent-override', ANTHROPIC_MODEL: 'anthropic-override' },
    { ANTHROPIC_MODEL: 'anthropic-override' },
  ]) {
    const { resolved, cleanup } = withProfile({ ...BASE, inferenceModels: ['ui-default'] }, overrides);
    try {
      assert.equal(resolved.model, overrides.CLAUDE_AGENT_MODEL || overrides.ANTHROPIC_MODEL);
    } finally { cleanup(); }
  }
});

test('empty or malformed lists preserve legacy scalar fallback', () => {
  for (const inferenceModels of [undefined, [], [' '], [{}], 'invalid']) {
    for (const scalar of [{ model: 'legacy-model' }, { defaultModel: 'legacy-default' }]) {
      const { resolved, cleanup } = withProfile({ ...BASE, ...scalar, inferenceModels });
      try {
        assert.equal(resolved.model, scalar.model || scalar.defaultModel);
      } finally { cleanup(); }
    }
  }
});

test('malformed object identity fields do not hide a valid fallback identity', () => {
  const { resolved, cleanup } = withProfile({
    ...BASE, inferenceModels: [null, ' ', { id: ' ', model: 42, name: ' usable-model ' }],
  });
  try {
    assert.equal(resolved.model, 'usable-model');
  } finally { cleanup(); }
});

test('a gateway override never adopts another gateway profile model list', () => {
  const { resolved, cleanup } = withProfile({ ...BASE, inferenceModels: ['private-profile-model'] }, {
    ANTHROPIC_BASE_URL: 'https://another.example.test', ANTHROPIC_API_KEY: 'test-key',
  });
  try {
    assert.equal(resolved.model, '');
  } finally { cleanup(); }
});

test('an empty or malformed inferenceModels is not mistaken for a model', () => {
  for (const bad of [[], ['   '], [{}], null, 'not-an-array']) {
    const { resolved, cleanup } = withProfile({ ...BASE, inferenceModels: bad });
    try {
      assert.equal(resolved.model, '', `malformed list ${JSON.stringify(bad)} produced a model`);
    } finally { cleanup(); }
  }
});

test('the resolver now mentions the key the UI writes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'agent-config.cjs'), 'utf8');
  assert.ok(src.includes('inferenceModels'), 'the key is not read by the resolver');
  assert.match(src, /firstFromList/, 'the list reader is missing');
  assert.match(src, /R637/, 'the repair is not annotated');
});

test('the UI key really is an array whose first entry is the default', () => {
  // The claim is checked against the shipped bundle, not against this test's assumption.
  const ion = path.join(ROOT, 'resources', 'ion-dist');
  const files = fs.existsSync(ion) ? fs.readdirSync(path.join(ion, 'assets', 'v1')).filter((f) => f.endsWith('.js')) : [];
  let found = '';
  for (const f of files) {
    const t = fs.readFileSync(path.join(ion, 'assets', 'v1', f), 'utf8');
    if (t.includes('First entry is the default')) { found = t; break; }
  }
  assert.ok(found, 'the bundle no longer documents the first-entry rule, so this fix may target the wrong key');
  assert.ok(found.includes('inferenceModels') || found.includes('Model list'), 'the rule is not adjacent to the model list field');
});
