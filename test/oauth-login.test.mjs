// OAuth login (authorization_code + PKCE) against the official CLI's contract.
// Constants and request shapes were read from claude.exe 2.1.308 -- see oauth-login.cjs.
// Nothing here talks to Anthropic: the browser and the token endpoint are stubs, while the
// loopback callback server is the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const oauth = require('../desktop/oauth-login.cjs');

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fetch stub that records requests and answers with a canned body. */
function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return { status, ok: status >= 200 && status < 300, async json() { return body; } };
  };
  impl.calls = calls;
  return impl;
}

const TOKEN_BODY = {
  access_token: 'at-123', refresh_token: 'rt-456', expires_in: 3600,
  scope: 'user:profile user:inference',
  account: { uuid: 'acc-1', email_address: 'me@example.com' },
  organization: { uuid: 'org-1', name: 'Me' },
};

test('the verifier/challenge pair follows RFC 7636 (S256)', () => {
  const { verifier, challenge, state } = oauth.generatePkce();
  assert.equal(challenge, b64url(crypto.createHash('sha256').update(verifier).digest()));
  assert.ok(verifier.length >= 43 && verifier.length <= 128, 'RFC 7636 length bounds');
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  assert.notEqual(state, verifier);
  // Two runs must not repeat.
  assert.notEqual(oauth.generatePkce().verifier, verifier);
});

test('the official RFC 7636 test vector produces the published challenge', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(b64url(crypto.createHash('sha256').update(verifier).digest()), expected);
});

test('the authorize URL carries every parameter the official client sends', () => {
  const url = new URL(oauth.buildAuthorizeUrl({ port: 4567, challenge: 'CH', state: 'ST' }));
  assert.equal(url.origin + url.pathname, 'https://claude.com/cai/oauth/authorize');
  const p = url.searchParams;
  assert.equal(p.get('code'), 'true');
  assert.equal(p.get('client_id'), '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('redirect_uri'), 'http://localhost:4567/callback');
  assert.equal(p.get('code_challenge'), 'CH');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('state'), 'ST');
  assert.equal(p.get('scope'), 'user:profile user:inference user:sessions:claude_code user:mcp_servers');
});

test('API-key minting is not requested by default', () => {
  assert.equal(oauth.DEFAULT_SCOPES.includes('org:create_api_key'), false);
});

test('the code exchange posts the shape the official client posts', async () => {
  const f = fakeFetch(200, TOKEN_BODY);
  const tokens = await oauth.exchangeCode({ code: 'C', verifier: 'V', state: 'S', port: 4567, fetchImpl: f, now: () => 1000 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(f.calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(f.calls[0].body, {
    grant_type: 'authorization_code', code: 'C', redirect_uri: 'http://localhost:4567/callback',
    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', code_verifier: 'V', state: 'S',
  });
  assert.equal(tokens.accessToken, 'at-123');
  assert.equal(tokens.refreshToken, 'rt-456');
  assert.equal(tokens.expiresAt, 1000 + 3600 * 1000);
  assert.deepEqual(tokens.scopes, ['user:profile', 'user:inference']);
  assert.equal(tokens.account.email, 'me@example.com');
  assert.equal(tokens.organization.uuid, 'org-1');
});

test('a 401 on exchange is reported as an invalid code, other failures as http errors', async () => {
  await assert.rejects(
    oauth.exchangeCode({ code: 'C', verifier: 'V', state: 'S', port: 1, fetchImpl: fakeFetch(401, {}) }),
    (e) => e.kind === 'invalid_code' && e.status === 401,
  );
  await assert.rejects(
    oauth.exchangeCode({ code: 'C', verifier: 'V', state: 'S', port: 1, fetchImpl: fakeFetch(500, {}) }),
    (e) => e.kind === 'http_error' && e.status === 500,
  );
});

test('a 200 without an access_token is an error, not an empty login', async () => {
  await assert.rejects(
    oauth.exchangeCode({ code: 'C', verifier: 'V', state: 'S', port: 1, fetchImpl: fakeFetch(200, { hello: 1 }) }),
    /no access_token/,
  );
});

test('refresh uses the refresh_token grant and keeps the old token when none is returned', async () => {
  const f = fakeFetch(200, { access_token: 'at-new', expires_in: 60 });
  const tokens = await oauth.refreshTokens({ refreshToken: 'rt-old', fetchImpl: f, now: () => 0 });
  assert.equal(f.calls[0].body.grant_type, 'refresh_token');
  assert.equal(f.calls[0].body.refresh_token, 'rt-old');
  assert.equal(f.calls[0].body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.equal(tokens.accessToken, 'at-new');
  assert.equal(tokens.refreshToken, 'rt-old', 'losing the refresh token would force a new login');
});

test('a rotated refresh token replaces the old one', async () => {
  const f = fakeFetch(200, { access_token: 'a', refresh_token: 'rt-rotated', expires_in: 60 });
  assert.equal((await oauth.refreshTokens({ refreshToken: 'rt-old', fetchImpl: f })).refreshToken, 'rt-rotated');
});

test('a rejected refresh token is distinguished from a server error', async () => {
  await assert.rejects(oauth.refreshTokens({ refreshToken: 'x', fetchImpl: fakeFetch(400, {}) }), (e) => e.kind === 'invalid_refresh_token');
  await assert.rejects(oauth.refreshTokens({ refreshToken: 'x', fetchImpl: fakeFetch(503, {}) }), (e) => e.kind === 'http_error');
});

test('needsRefresh honours the safety margin and tolerates unknown expiry', () => {
  const now = () => 1_000_000;
  assert.equal(oauth.needsRefresh({ expiresAt: 1_000_000 + 10 * 60 * 1000 }, 5 * 60 * 1000, now), false);
  assert.equal(oauth.needsRefresh({ expiresAt: 1_000_000 + 4 * 60 * 1000 }, 5 * 60 * 1000, now), true);
  assert.equal(oauth.needsRefresh({ expiresAt: 1_000_000 - 1 }, 5 * 60 * 1000, now), true);
  assert.equal(oauth.needsRefresh({ expiresAt: null }), false);
  assert.equal(oauth.needsRefresh(null), false);
});

// ---- the full flow over a real loopback listener -------------------------

/** A "browser" that reads the authorize URL and calls the callback like the real redirect. */
function browserThatReturns(makeQuery) {
  const seen = {};
  const openBrowser = async (authorizeUrl) => {
    const u = new URL(authorizeUrl);
    seen.authorizeUrl = authorizeUrl;
    seen.redirect = u.searchParams.get('redirect_uri');
    seen.state = u.searchParams.get('state');
    const query = makeQuery(seen);
    // Fire and forget: the flow resolves when the callback has been processed.
    fetch(`${seen.redirect}?${query}`, { redirect: 'manual' }).then((r) => { seen.status = r.status; seen.location = r.headers.get('location'); }).catch(() => {});
  };
  return { openBrowser, seen };
}

test('full flow: correct state -> tokens, success redirect, listener closed', async () => {
  const f = fakeFetch(200, TOKEN_BODY);
  const { openBrowser, seen } = browserThatReturns((s) => `code=CODE1&state=${encodeURIComponent(s.state)}`);
  const tokens = await oauth.startLoginFlow({ openBrowser, fetchImpl: f, timeoutMs: 5000 });

  assert.equal(tokens.accessToken, 'at-123');
  assert.equal(f.calls.length, 1, 'exactly one exchange');
  assert.equal(f.calls[0].body.code, 'CODE1');
  assert.equal(f.calls[0].body.redirect_uri, seen.redirect, 'must reuse the redirect the browser was sent with');
  assert.ok(f.calls[0].body.code_verifier.length >= 43);

  // The browser was sent on to Anthropic's own success page.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.status, 302);
  assert.equal(seen.location, 'https://platform.claude.com/oauth/code/success?app=claude-code');

  // The listener is gone: a second callback must fail to connect.
  await assert.rejects(fetch(`${seen.redirect}?code=X&state=${seen.state}`), 'the loopback port must be closed');
});

test('full flow: a callback with the wrong state is never exchanged', async () => {
  const f = fakeFetch(200, TOKEN_BODY);
  const { openBrowser } = browserThatReturns(() => 'code=EVIL&state=not-our-state');
  await assert.rejects(
    oauth.startLoginFlow({ openBrowser, fetchImpl: f, timeoutMs: 5000 }),
    (e) => e.kind === 'state_mismatch',
  );
  assert.equal(f.calls.length, 0, 'a forged callback must never reach the token endpoint');
});

test('full flow: a callback with no code is refused', async () => {
  const f = fakeFetch(200, TOKEN_BODY);
  const { openBrowser } = browserThatReturns((s) => `state=${encodeURIComponent(s.state)}`);
  await assert.rejects(oauth.startLoginFlow({ openBrowser, fetchImpl: f, timeoutMs: 5000 }), (e) => e.kind === 'state_mismatch');
  assert.equal(f.calls.length, 0);
});

test('full flow: the user declining surfaces as "refused"', async () => {
  const f = fakeFetch(200, TOKEN_BODY);
  const { openBrowser } = browserThatReturns(() => 'error=access_denied');
  await assert.rejects(oauth.startLoginFlow({ openBrowser, fetchImpl: f, timeoutMs: 5000 }), (e) => e.kind === 'refused' && /access_denied/.test(e.message));
  assert.equal(f.calls.length, 0);
});

test('full flow: a failed exchange rejects and still closes the listener', async () => {
  const f = fakeFetch(401, {});
  const { openBrowser, seen } = browserThatReturns((s) => `code=BAD&state=${encodeURIComponent(s.state)}`);
  await assert.rejects(oauth.startLoginFlow({ openBrowser, fetchImpl: f, timeoutMs: 5000 }), (e) => e.kind === 'invalid_code');
  await assert.rejects(fetch(`${seen.redirect}?code=X&state=${seen.state}`));
});

test('full flow: nobody completes the login -> timeout, listener closed', async () => {
  let redirect = null;
  await assert.rejects(
    oauth.startLoginFlow({
      openBrowser: async (u) => { redirect = new URL(u).searchParams.get('redirect_uri'); },
      fetchImpl: fakeFetch(200, TOKEN_BODY),
      timeoutMs: 80,
    }),
    (e) => e.kind === 'timeout',
  );
  await assert.rejects(fetch(redirect), 'the loopback port must be closed after a timeout');
});

test('full flow: a browser that cannot be opened rejects instead of hanging', async () => {
  await assert.rejects(
    oauth.startLoginFlow({ openBrowser: async () => { throw new Error('no browser'); }, fetchImpl: fakeFetch(200, TOKEN_BODY), timeoutMs: 5000 }),
    /no browser/,
  );
});

test('startLoginFlow insists on an openBrowser function', () => {
  assert.throws(() => oauth.startLoginFlow({}), /openBrowser is required/);
});
