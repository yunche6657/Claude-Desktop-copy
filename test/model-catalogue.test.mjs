// The model picker must offer every model the gateway serves.
//
// Measured on the replica, before the fix: the picker listed exactly one entry while the
// gateway answered /v1/models with 15 ids (deepseek-v4-pro, gpt-5.5, glm-5.3, kimi-k3...).
// The renderer could then only ever push one back:
//
//   [trace] LocalSessions.setAvailableCodeModels [["deepseek-v4.1-flash"]]
//
// The cause was in the bootstrap: withResolvedModel replaced each catalogue with
// `models: [entry]`, so the single resolved model was the whole world.
//
// After the fix the menu renders deepseek-v4.1-flash (默认) followed by deepseek-v4-pro,
// gemini-3.5-flash, glm-5.2, glm-5.3, glm-5.3-flash, glm-5.3-flashx, gpt-5.5, gpt-6-astra...
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { withResolvedModel } = require(path.join(ROOT, 'desktop', 'bootstrap-service.cjs'));

const payload = () => ({
  model_selector_config: [{ id: 'code', models: [{ id: 'old', name: 'old' }] }],
  model_selector_state: [{ id: 'code', model: 'old' }],
});

test('the catalogue carries every gateway model, current one first', () => {
  const out = withResolvedModel(payload(), 'deepseek-v4.1-flash', ['deepseek-v4-pro', 'gpt-5.5']);
  const models = out.model_selector_config[0].models;
  assert.equal(models.length, 3, 'expected the current model plus the two supplied');
  assert.equal(models[0].id, 'deepseek-v4.1-flash', 'the current model must be first so it stays selected');
  assert.deepEqual(models.map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'gpt-5.5']);
});

test('the selected state points at the current model', () => {
  const out = withResolvedModel(payload(), 'gpt-5.5', ['deepseek-v4-pro']);
  assert.equal(out.model_selector_state[0].model, 'gpt-5.5');
});

test('without a catalogue only the resolved model is offered', () => {
  // The honest fallback: never invent ids, never keep the stale reference catalogue.
  const out = withResolvedModel(payload(), 'only-this-one');
  const models = out.model_selector_config[0].models;
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'only-this-one');
});

test('the current model is not duplicated when it also appears in the catalogue', () => {
  const out = withResolvedModel(payload(), 'dup', ['dup', 'other']);
  const ids = out.model_selector_config[0].models.map((m) => m.id);
  assert.deepEqual(ids, ['dup', 'other'], 'duplicate id in the menu');
});

test('the bridge shares its fetched catalogue with the bootstrap', () => {
  // The bootstrap renders synchronously, so it reads a cache the bridge warms; if the
  // accessor disappeared the picker would silently fall back to one model again.
  const bridge = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  assert.equal(typeof bridge.knownGatewayModels, 'function', 'the accessor is missing');
  assert.equal(typeof bridge.rememberGatewayModels, 'function', 'the writer is missing');
  bridge.rememberGatewayModels(['a', 'b']);
  assert.deepEqual(bridge.knownGatewayModels(), ['a', 'b']);
});
