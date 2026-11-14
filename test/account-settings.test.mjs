// Account-scoped settings must be writable.
//
// The Settings UI writes them with
//
//   PATCH /api/account/settings   { <field>: <value> }
//
// and reads them back from `account.settings[field]`. With no backend that PATCH
// 503'd, so every account-scoped control (Default transcript view, …) silently
// reverted — the control moved, then snapped back on the next profile read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApiInterceptors } = require('../desktop/api-interceptors.cjs');

const bootstrapFixture = {
  account: {
    uuid: 'e9b02a25-14e9-408e-a04f-cbd274ae2f26',
    email_address: 'cowork-3p@localhost',
    memberships: [],
    settings: { paprika_mode: 'auto' },
  },
};

/** An in-memory stand-in for the on-disk settings overlay. */
function makeStore(initial = {}) {
  let stored = { ...initial };
  return {
    read: () => ({ ...stored }),
    write: (patch) => { stored = { ...stored, ...patch }; return { ...stored }; },
    raw: () => stored,
  };
}

const make = (store) => createApiInterceptors({
  bootstrap: () => bootstrapFixture,
  readSettings: store.read,
  writeSettings: store.write,
});

const patch = (body) => new Request('app://localhost/api/account/settings', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('PATCH /api/account/settings is accepted, not 503', async () => {
  const store = makeStore();
  const res = await make(store)(patch({ code_default_transcript_view: 'verbose' }), '/api/account/settings');
  assert.ok(res, 'must be intercepted rather than forwarded');
  assert.equal(res.status, 200);
});

test('the written setting is readable back from the profile', async () => {
  // This is the round trip that makes a Settings control stick.
  const store = makeStore();
  const intercept = make(store);

  await intercept(patch({ code_default_transcript_view: 'thinking' }), '/api/account/settings');
  const profile = await intercept(
    new Request('app://localhost/api/account_profile'), '/api/account_profile').json();

  assert.equal(profile.settings.code_default_transcript_view, 'thinking');
});

test('a write merges rather than replacing the settings bag', async () => {
  // The bootstrap's own settings must survive; a replace would drop paprika_mode
  // and everything else the app reads.
  const store = makeStore();
  const intercept = make(store);
  await intercept(patch({ code_default_transcript_view: 'verbose' }), '/api/account/settings');

  const profile = await intercept(
    new Request('app://localhost/api/account_profile'), '/api/account_profile').json();
  assert.equal(profile.settings.paprika_mode, 'auto', 'bootstrap settings must survive');
  assert.equal(profile.settings.code_default_transcript_view, 'verbose');
});

test('successive writes accumulate', async () => {
  const store = makeStore();
  const intercept = make(store);
  await intercept(patch({ a: 1 }), '/api/account/settings');
  await intercept(patch({ b: 2 }), '/api/account/settings');

  const profile = await intercept(
    new Request('app://localhost/api/account_profile'), '/api/account_profile').json();
  assert.equal(profile.settings.a, 1);
  assert.equal(profile.settings.b, 2);
});

test('the PATCH reply carries the merged settings', async () => {
  const store = makeStore({ existing: 'keep' });
  // Reading the request body is async, so the intercepted answer is a promise.
  const res = await make(store)(patch({ added: 'new' }), '/api/account/settings');
  const body = await res.json();
  assert.equal(body.settings.added, 'new');
  assert.equal(body.settings.existing, 'keep');
});

test('an invalid body is refused instead of stored', async () => {
  const store = makeStore();
  const res = await make(store)(
    new Request('app://localhost/api/account/settings', { method: 'PATCH', body: 'not json' }),
    '/api/account/settings');
  assert.equal(res.status, 400);
  assert.deepEqual(store.raw(), {}, 'nothing may be written for a bad body');
});

test('an array body is refused', async () => {
  const store = makeStore();
  const res = await make(store)(patch([1, 2, 3]), '/api/account/settings');
  assert.equal(res.status, 400);
});

test('with no writer configured the PATCH reports 501 rather than pretending', async () => {
  // Better an explicit "not writable" than a 200 that stores nothing and makes the
  // control look like it worked.
  const intercept = createApiInterceptors({ bootstrap: () => bootstrapFixture });
  const res = await intercept(patch({ x: 1 }), '/api/account/settings');
  assert.equal(res.status, 501);
});

test('a throwing writer reports 500 instead of crashing the request', async () => {
  const intercept = createApiInterceptors({
    bootstrap: () => bootstrapFixture,
    readSettings: () => ({}),
    writeSettings: () => { throw new Error('disk full'); },
  });
  const res = await intercept(patch({ x: 1 }), '/api/account/settings');
  assert.equal(res.status, 500);
});

test('the /edge-api spelling of the settings path works too', async () => {
  const store = makeStore();
  const res = await make(store)(patch({ k: 'v' }), '/edge-api/account/settings');
  assert.equal(res.status, 200);
  assert.equal(store.raw().k, 'v');
});

test('GET on the settings path is not intercepted', async () => {
  // Only the write is ours; a read goes through the normal profile path.
  const store = makeStore();
  const res = await make(store)(
    new Request('app://localhost/api/account/settings'), '/api/account/settings');
  assert.equal(res, null);
});
