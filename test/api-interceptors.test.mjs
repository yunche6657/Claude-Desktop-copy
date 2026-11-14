// Tests for the local API interception stage.
//
// The shipped protocol handler intercepts a few paths before forwarding
// (its Jgn stage). This build has no backend, so without an equivalent stage every
// /api/* request answered 503 and the app behaved as permanently offline — the
// account Overview page sat on "Loading Overview" because the profile query it
// waits on never settled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApiInterceptors } = require('../desktop/api-interceptors.cjs');

const bootstrapFixture = {
  account: {
    uuid: 'e9b02a25-14e9-408e-a04f-cbd274ae2f26',
    tagged_id: 'cowork_3p_e9b02a25',
    email_address: 'cowork-3p@localhost',
    full_name: 'Administrator',
    display_name: 'Administrator',
    is_verified: true,
    age_is_verified: true,
    memberships: [{ role: 'admin' }],
    workspace_memberships: [],
    settings: { paprika_mode: 'default' },
  },
};

const make = () => createApiInterceptors({ bootstrap: () => bootstrapFixture });
const req = (path, method = 'GET') => new Request(`app://localhost${path}`, { method });

test('account_profile answers the account record, not 503', async () => {
  const intercept = make();
  const res = intercept(req('/api/account_profile'), '/api/account_profile');
  assert.ok(res, 'must be intercepted rather than forwarded');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.uuid, bootstrapFixture.account.uuid);
  assert.equal(body.email_address, 'cowork-3p@localhost');
});

test('account_profile carries the fields its consumers read', async () => {
  // `gq()` reads cowork_instructions_union, the personalization pane reads
  // conversation_preferences and the avatar fields.
  const intercept = make();
  const body = await intercept(req('/api/account_profile'), '/api/account_profile').json();
  for (const key of ['uuid', 'email_address', 'conversation_preferences',
    'cowork_instructions_union', 'avatar_image_url', 'memberships']) {
    assert.ok(key in body, `missing ${key}`);
  }
  // Anything other than exactly true means "union is off", the safe default.
  assert.equal(body.cowork_instructions_union, false);
  // A STRING, not an object: the pane iterates it to compute text direction, so an
  // object throws "e is not iterable" and takes the whole settings route down.
  // (An earlier version of this test asserted 'object' and so endorsed that bug.)
  assert.equal(typeof body.conversation_preferences, 'string');
});

test('the /edge-api spelling is intercepted too', async () => {
  // The shipped handler rewrites /edge-api/x to /api/x before intercepting, so the
  // same table must serve both.
  const intercept = make();
  const res = intercept(req('/edge-api/account_profile'), '/edge-api/account_profile');
  assert.ok(res);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).uuid, bootstrapFixture.account.uuid);
});

test('telemetry endpoints are accepted and dropped', async () => {
  // A 503 makes the client retry with backoff forever; a collector returns 200.
  const intercept = make();
  for (const path of ['/api/v2/rum', '/api/event_logging/v2/batch']) {
    const res = intercept(req(path, 'POST'), path);
    assert.ok(res, `${path} must be intercepted`);
    assert.equal(res.status, 200);
  }
});

test('unknown API paths are left to the forwarder', () => {
  // The interceptor must not swallow requests it does not understand; those still
  // need the real forward path (or its 503) rather than a fabricated answer.
  const intercept = make();
  for (const path of ['/api/some_other_thing', '/api/account/avatar', '/api/v2/other']) {
    assert.equal(intercept(req(path), path), null, `${path} must not be intercepted`);
  }
});

test('a missing bootstrap does not fabricate an account', () => {
  // With no bootstrap there is no account to describe, so the request must fall
  // through rather than answer an empty profile the UI would render as real.
  const intercept = createApiInterceptors({ bootstrap: () => null });
  assert.equal(intercept(req('/api/account_profile'), '/api/account_profile'), null);
});

test('a throwing bootstrap does not break the request', () => {
  const intercept = createApiInterceptors({ bootstrap: () => { throw new Error('boom'); } });
  assert.equal(intercept(req('/api/account_profile'), '/api/account_profile'), null);
});

test('account_profile only answers GET', async () => {
  // The PUT on this path is a profile write, which this build cannot honour; it
  // must reach the forwarder instead of being answered with the old profile.
  const intercept = make();
  assert.equal(intercept(req('/api/account_profile', 'PUT'), '/api/account_profile'), null);
});
