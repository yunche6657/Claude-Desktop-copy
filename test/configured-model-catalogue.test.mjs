import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildBootstrap, createBootstrapResponder, withResolvedModel } = require('../desktop/bootstrap-service.cjs');
const { registerBridgeServices, messageChannel, rememberGatewayModels } = require('../desktop/bridge-services.cjs');
const { applyStartupDefaults } = require('../desktop/startup-defaults.cjs');

const models = Array.from({ length: 15 }, (_, i) => ({ id: `configured-${i}` }));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-models-'));
  const saved = { ...process.env };
  process.env.LOCALAPPDATA = root;
  process.env.APPDATA = root;
  delete process.env.CLAUDE_AGENT_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.CLAUDE_REPLICA_DERIVED_DEFAULTS;
  const dir = path.join(root, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(dir, { recursive: true });
  const id = '11111111-1111-1111-1111-111111111111';
  const otherId = '22222222-2222-2222-2222-222222222222';
  const body = { inferenceGatewayBaseUrl: 'https://catalogue-fixture.invalid', inferenceModels: models };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
  fs.writeFileSync(path.join(dir, `${otherId}.json`), JSON.stringify({ ...body, inferenceModels: ['other-model'] }));
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ appliedId: id, entries: [{ id, name: 'active' }, { id: otherId, name: 'other' }] }));
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dir, id, otherId, body };
}

test('cold bootstrap reads all 15 configured models and normalizes object entries', t => {
  fixture(t);
  const payload = buildBootstrap();
  for (const section of payload.model_selector_config) assert.deepEqual(section.models.map(row => row.id), models.map(row => row.id));
  const selector = withResolvedModel({}, '', [' a ', { model: 'b' }, { name: 'a' }, null]).model_selector_config[0];
  assert.deepEqual(selector.models.map(row => row.id), ['a', 'b']);
  for (const row of selector.models) assert.equal(row.thinking, undefined, 'unknown model capabilities must not invent effort options');
});

test('bootstrap responder rereads configuration and ignores another gateway discovery cache', t => {
  const { dir, id, body } = fixture(t);
  rememberGatewayModels(['stale-discovery'], { baseUrl: 'https://old.invalid' });
  applyStartupDefaults(process.env);
  const responder = createBootstrapResponder();
  assert.equal(responder.payload().model_selector_state[0].model, 'configured-0');
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ...body, inferenceModels: ['saved-model', 'saved-second'] }));
  assert.deepEqual(responder.payload().model_selector_config[0].models.map(row => row.id), ['saved-model', 'saved-second']);
  assert.equal(process.env.CLAUDE_AGENT_MODEL, 'configured-0', 'reading bootstrap must not change runtime environment');
});

test('availableModels uses configured catalogue offline and refreshes after save/apply', async t => {
  const { root, id, otherId, body } = fixture(t);
  applyStartupDefaults(process.env);
  const handlers = new Map();
  let changed = 0;
  const bridge = registerBridgeServices({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) },
    bridgeMap: require('../desktop/shim/bridge-map.json'), getMainWindow: () => null,
    settings: { dataDir: path.join(root, 'data'), projectPath: root }, frontend: { root },
    onModelCatalogChanged: () => { changed += 1; },
  });
  t.after(() => bridge.dispose());
  const call = (domain, service, method, ...args) => handlers.get(messageChannel(domain, service, method))({}, ...args);
  const read = () => call('claude.web', 'ClaudeCode', 'resolveLocalSettings');
  assert.deepEqual((await read()).availableModels.value, models.map(row => row.id));
  assert.equal((await call('claude.settings', 'Custom3pSetup', 'writeConfig', otherId, { ...body, inferenceModels: ['other-model'] })).ok, true);
  assert.equal(changed, 0, 'editing an inactive profile must not refresh the main window');
  assert.equal((await call('claude.settings', 'Custom3pSetup', 'writeConfig', id, { ...body, inferenceModels: ['saved-model', 'saved-second'] })).ok, true);
  assert.deepEqual((await read()).availableModels.value, ['saved-model', 'saved-second']);
  assert.equal(changed, 1);
  await call('claude.settings', 'Custom3pSetup', 'setAppliedConfig', otherId);
  assert.deepEqual((await read()).availableModels.value, ['other-model']);
  assert.equal(changed, 2);
});
