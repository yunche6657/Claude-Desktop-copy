// Unit tests for the synthetic 3p bootstrap and the persisted store seeds.
//
// The shape asserted here is the one observed on a running original in 3p mode:
// a synthetic localhost account, org uuid 00000000-0000-4000-8000-000000000001,
// and the ccd-session-store v5 envelope with worker {type:'environment'}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  syntheticIdentity,
  buildBootstrap,
  isBootstrapRequest,
  createBootstrapResponder,
  BOOTSTRAP_PATH,
} = require('../desktop/bootstrap-service.cjs');
const { ORG_UUID, buildSeeds } = require('../desktop/store-seed.cjs');

test('syntheticIdentity is uuid v4 shaped and stable per seed', () => {
  const a = syntheticIdentity('seed-a');
  const b = syntheticIdentity('seed-a');
  const c = syntheticIdentity('seed-b');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('buildBootstrap produces the observed account shape', () => {
  const b = buildBootstrap({ seed: 'test-seed' });
  assert.equal(b.account.email_address, 'cowork-3p@localhost');
  assert.equal(b.account.is_verified, true);
  assert.equal(b.account.age_is_verified, true);
  assert.match(b.account.uuid, /^[0-9a-f-]{36}$/);
  assert.match(b.account.tagged_id, /^cowork_3p_/);
  assert.ok(Array.isArray(b.account.memberships));
});

test('the account carries a display name so the sidebar row is not blank', () => {
  // The row renders `full_name || display_name || email_address`, but the component
  // collapses when both names are empty strings. A synthetic local name fixes it.
  const b = buildBootstrap({ seed: 'name-check' });
  assert.equal(typeof b.account.full_name, 'string');
  assert.ok(b.account.full_name.length > 0, 'full_name must not be empty');
  assert.equal(b.account.display_name, b.account.full_name);
});

test('buildBootstrap carries every top-level key the frontend reads', () => {
  const b = buildBootstrap({ seed: 'x' });
  for (const key of [
    'account', 'current_user_access', 'featureFlagsOrgUuid', 'locale',
    'statsig', 'feature_flags', 'growthbook', 'model_selector_config',
    'model_selector_state', 'bootstrap_push_revision', 'intercom_account_hash',
    'gated_imports', 'gated_imports_build_id', 'system_prompts',
  ]) {
    assert.ok(key in b, `missing ${key}`);
  }
});

test('isBootstrapRequest matches the bootstrap paths only', () => {
  assert.equal(isBootstrapRequest(`app://localhost${BOOTSTRAP_PATH}`), true);
  assert.equal(isBootstrapRequest('app://localhost/api/bootstrap'), true);
  assert.equal(isBootstrapRequest('app://localhost/api/sessions'), false);
  assert.equal(isBootstrapRequest('app://localhost/epitaxy'), false);
  assert.equal(isBootstrapRequest('not a url'), false);
});

test('responder returns 200 JSON and is stable across calls', async () => {
  const r = createBootstrapResponder({ seed: 'stable' });
  const first = r.respond();
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /json/);
  const a = await first.text();
  const b = await r.respond().text();
  assert.equal(a, b);
});

test('the captured template is used, so the feature bags are present', () => {
  // The template is the normal source: growthbook/statsig bags and the model
  // selector catalogue all come from it. A payload without them cannot resolve a
  // surface, so this asserts the template is actually applied.
  const payload = createBootstrapResponder({ seed: 't' }).payload();
  const growthbookFeatures = Object.keys(payload.growthbook?.features || {});
  assert.ok(growthbookFeatures.length > 0, 'growthbook features missing');
  assert.ok(Array.isArray(payload.model_selector_config), 'model_selector_config missing');
});

test('an explicit template path wins over the captured sample', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'boot-'));
  const file = path.join(dir, 'template.json');
  writeFileSync(file, JSON.stringify({ bootstrap_push_revision: 4242, growthbook: { features: {} } }));
  const payload = createBootstrapResponder({ seed: 't', templatePath: file }).payload();
  assert.equal(payload.bootstrap_push_revision, 4242);
});

test('store seeds carry the observed keys and structure', () => {
  const seeds = buildSeeds({ accountUuid: 'acct-1', sidebarWidth: 288 });
  const map = Object.fromEntries(seeds);

  assert.ok(map['ccd-session-store'], 'ccd-session-store missing');
  const store = JSON.parse(map['ccd-session-store']);
  assert.equal(store.version, 5);
  assert.deepEqual(store.state.worker, { type: 'environment', id: '__local__' });
  assert.equal(store.state.currentHostKey, 'local');
  assert.equal(store.state.orgUuid, ORG_UUID);

  assert.equal(map['ccd-sync-owner'], 'acct-1');
  assert.equal(map['code-session-presets-latch'], 'off');

  const dframe = JSON.parse(map['dframe-store']);
  assert.equal(dframe.state.sidebarWidth, 288);
  assert.equal(dframe.state.collapsed, false);
  assert.equal(dframe.state.interfaceFont, 'anthropic');
});

test('store seeds honour a custom sidebar width', () => {
  const map = Object.fromEntries(buildSeeds({ accountUuid: 'a', sidebarWidth: 320 }));
  assert.equal(JSON.parse(map['dframe-store']).state.sidebarWidth, 320);
});
