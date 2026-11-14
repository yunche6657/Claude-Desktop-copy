
// The language picker's write path. Kept beside the other interceptor tests because the
// behaviour is a property of that stage.
//
// Measured on the shipped frontend (resources/ion-dist/assets/v1/shared-25-DOWZRSlq.js):
//   the picker's mutation is  Tn("/api/account_profile", "PUT", ...)
//   and the picker calls it as  mutateAsync({ locale })
// So a choice only survives a restart if this PUT is answered AND the bootstrap document
// advertises the stored value on the next launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApiInterceptors } = require('../desktop/api-interceptors.cjs');

const fixture = {
  account: {
    uuid: 'acct-1',
    email_address: 'cowork-3p@localhost',
    full_name: 'Administrator',
    display_name: 'Administrator',
    settings: {},
  },
};

function make(store = {}) {
  const state = { ...store };
  return {
    state,
    intercept: createApiInterceptors({
      bootstrap: () => fixture,
      readSettings: () => state,
      writeSettings: (patch) => Object.assign(state, patch),
      acceptLocaleWrites: true,
    }),
  };
}

const put = (body) => new Request('app://localhost/api/account_profile', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('the language picker PUT is answered and persisted', async () => {
  const { intercept, state } = make();
  const res = await intercept(put({ locale: 'ja-JP' }), '/api/account_profile');
  assert.ok(res, 'must be intercepted');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.locale, 'ja-JP');
  assert.equal(body.uuid, 'acct-1');
  assert.equal(state.locale, 'ja-JP', 'the choice must reach the persistent store');
});

test('the edge-api spelling of the same write is answered', async () => {
  const { intercept, state } = make();
  const req = new Request('app://localhost/edge-api/account_profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locale: 'zh-Hans' }),
  });
  const res = await intercept(req, '/edge-api/account_profile');
  assert.ok(res);
  assert.equal(state.locale, 'zh-Hans');
});

test('a malformed locale is refused, not stored', async () => {
  const { intercept, state } = make();
  for (const bad of [{ locale: '' }, { locale: '../etc' }, { locale: 42 }, {}]) {
    const res = await intercept(put(bad), '/api/account_profile');
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(state.locale, undefined);
});

test('the write is refused when nothing can persist it', async () => {
  const intercept = createApiInterceptors({
    bootstrap: () => fixture,
    acceptLocaleWrites: true,
  });
  const res = await intercept(put({ locale: 'ja-JP' }), '/api/account_profile');
  assert.equal(res.status, 501);
});

test('without opt-in the PUT still falls through to the forwarder', () => {
  // General profile writes (avatar, custom instructions) are not honour-able by this
  // build; they must keep reaching the forwarder rather than getting a stale profile.
  const intercept = createApiInterceptors({ bootstrap: () => fixture });
  assert.equal(intercept(put({ locale: 'ja-JP' }), '/api/account_profile'), null);
});
