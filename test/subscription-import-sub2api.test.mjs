import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseSubscription } = require('../desktop/subscription-import.cjs');

const account = () => ({
  name: 'Sub2API Claude fixture', platform: 'anthropic', type: 'oauth',
  // Account scheduling expiry is distinct from OAuth credential expiry.
  expires_at: 1,
  credentials: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: '4102444800', scope: 'user:profile user:inference' },
  extra: { account_uuid: 'fixture-account' },
});

test('Sub2API account preserves OAuth refresh, expiry and scopes, not scheduling or extra fields', () => {
  const result = parseSubscription({ input: JSON.stringify(account()) });
  assert.equal(result.name, 'Sub2API Claude fixture');
  assert.deepEqual(result.tokens, {
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 4102444800000,
    scopes: ['user:profile', 'user:inference'],
  });
  assert.deepEqual(result.config.credentials, { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 4102444800000 });
  assert.equal(result.config.inferenceGatewayBaseUrl, 'https://api.anthropic.com');
});

test('Sub2API single-account export supports current, legacy, API and account wrappers', () => {
  const bundles = [
    { exported_at: '2026-01-01T00:00:00Z', proxies: [], accounts: [account()] },
    { type: 'sub2api-data', version: 1, proxies: [], accounts: [account()] },
    { type: 'sub2api-bundle', version: 1, proxies: [], accounts: [account()] },
    { code: 0, data: { proxies: [], accounts: [account()] } },
    { account: account() },
  ];
  for (const input of bundles) {
    const result = parseSubscription({ input, name: 'Chosen name', model: 'chosen-model' });
    assert.equal(result.tokens.refreshToken, 'fixture-refresh');
    assert.equal(result.name, 'Chosen name');
    assert.equal(result.config.inferenceModels[0].id, 'chosen-model');
  }
});

test('Sub2API bundle requires exactly one account and supported header', () => {
  for (const accounts of [[], [account(), account()], null, {}, [null]]) {
    assert.throws(() => parseSubscription({ input: { accounts } }));
  }
  for (const header of [{ type: 'other-export' }, { version: 2 }]) {
    assert.throws(() => parseSubscription({ input: { ...header, accounts: [account()] } }));
  }
});

test('provider and API key exports do not get routed as Claude subscriptions', () => {
  for (const platform of ['openai', 'gemini', 'antigravity', '', {}]) {
    assert.throws(() => parseSubscription({ input: { ...account(), platform } }), /Anthropic/);
  }
  assert.throws(() => parseSubscription({ input: { ...account(), type: 'apikey' } }), /OAuth/);
  assert.equal(parseSubscription({ input: { ...account(), type: 'setup-token' } }).tokens.accessToken, 'fixture-access');
});

test('2FA text, otpauth and password objects are detected without leaking supplied fields', () => {
  const values = [
    'fixture@example.test----fixture-password----fixture-mfa',
    'fixture@example.test,fixture-password,fixture-mfa',
    'otpauth://totp/fixture?secret=fixture-mfa',
    { email: 'fixture@example.test', password: 'fixture-password', mfa_secret: 'fixture-mfa' },
    { accessToken: 'fixture-access', mfa_secret: 'fixture-mfa' },
  ];
  for (const input of values) {
    assert.throws(() => parseSubscription({ input }), error => {
      assert.match(error.message, /2FA/);
      assert.doesNotMatch(error.message, /fixture/);
      return true;
    });
  }
});

test('expired access can retain refresh while malformed grants and refresh fail cleanly', () => {
  const expired = account();
  expired.credentials.expires_at = 1;
  assert.equal(parseSubscription({ input: expired }).tokens.expiresAt, 1000);
  delete expired.credentials.refresh_token;
  assert.throws(() => parseSubscription({ input: expired }), /已过期/);
  for (const credentials of [[], 'fixture-secret', 42, { access_token: 'fixture-access', refresh_token: 'bad refresh' }]) {
    assert.throws(() => parseSubscription({ input: { ...account(), credentials } }));
  }
});

test('existing Claude credentials retain millisecond and ISO expiry formats and account metadata', () => {
  for (const expiresAt of [4102444800000, '2100-01-01T00:00:00.000Z']) {
    const result = parseSubscription({ input: { claudeAiOauth: { accessToken: 'fixture-access', expiresAt, scopes: ['user:inference'] }, account: { uuid: 'fixture-uuid' } } });
    assert.equal(result.tokens.expiresAt, 4102444800000);
    assert.deepEqual(result.tokens.account, { uuid: 'fixture-uuid' });
  }
});
