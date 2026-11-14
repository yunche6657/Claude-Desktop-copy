// OAuth login for a Claude subscription (authorization_code + PKCE).
//
// Every constant below was read from the official claude.exe 2.1.308 (raw bytes, not the
// readable-text run -- these strings live in the bytecode region):
//
//   CLIENT_ID:               "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
//   CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize"   (subscription login)
//   CONSOLE_AUTHORIZE_URL:   "https://platform.claude.com/oauth/authorize" (API-billing login)
//   TOKEN_URL:               "https://platform.claude.com/v1/oauth/token"
//   MANUAL_REDIRECT_URL:     "https://platform.claude.com/oauth/code/callback"
//   beta header:             "oauth-2025-04-20"
//
// and the request shapes (function DWr = authorize URL, FWo = code exchange):
//   authorize: code=true, client_id, response_type=code,
//              redirect_uri=http://localhost:<port>/callback, scope, code_challenge,
//              code_challenge_method=S256, state
//   exchange:  POST JSON {grant_type:"authorization_code", code, redirect_uri, client_id,
//              code_verifier, state}
//   refresh:   grant_type "refresh_token"
//
// The user signs in themselves in their own browser (Google, e-mail, whatever claude.ai
// offers). This module never sees a password; it only receives the one-time code on the
// loopback callback and trades it for tokens.
//
// Network, browser and clock are injected so the whole flow is testable without logging in.
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const OAUTH = Object.freeze({
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  consoleAuthorizeUrl: 'https://platform.claude.com/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  successUrl: 'https://platform.claude.com/oauth/code/success?app=claude-code',
  betaHeader: 'oauth-2025-04-20',
});

// The scope set quoted by the official error text for refresh tokens:
//   "user:profile user:inference user:sessions:claude_code user:mcp_servers"
// org:create_api_key is deliberately NOT requested: an agent that only needs inference and
// the usage readout has no use for minting API keys.
const DEFAULT_SCOPES = Object.freeze([
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
]);

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Fresh PKCE material. `randomBytes` is injectable so tests can pin it. */
function generatePkce(randomBytes = crypto.randomBytes) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(32));
  return { verifier, challenge, state };
}

/** The URL the user's browser is sent to. */
function buildAuthorizeUrl({ port, challenge, state, scopes = DEFAULT_SCOPES, loginHint, base = OAUTH.authorizeUrl }) {
  const url = new URL(base);
  url.searchParams.append('code', 'true');
  url.searchParams.append('client_id', OAUTH.clientId);
  url.searchParams.append('response_type', 'code');
  url.searchParams.append('redirect_uri', `http://localhost:${port}/callback`);
  url.searchParams.append('scope', scopes.join(' '));
  url.searchParams.append('code_challenge', challenge);
  url.searchParams.append('code_challenge_method', 'S256');
  url.searchParams.append('state', state);
  if (loginHint) url.searchParams.append('login_hint', loginHint);
  return url.toString();
}

/** Normalise a token endpoint body. Throws when the essentials are missing. */
function normalizeTokens(body, now = Date.now) {
  if (!body || typeof body !== 'object' || typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('token endpoint response has no access_token');
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : now() + expiresIn * 1000,
    scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [],
    account: body.account && typeof body.account === 'object'
      ? { uuid: body.account.uuid || null, email: body.account.email_address || body.account.email || null }
      : null,
    organization: body.organization && typeof body.organization === 'object'
      ? { uuid: body.organization.uuid || null, name: body.organization.name || null }
      : null,
  };
}

async function postJson(fetchImpl, url, payload) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, ok: res.ok, body };
}

/** Trade the one-time code for tokens. */
async function exchangeCode({ code, verifier, state, port, fetchImpl = fetch, now = Date.now }) {
  const { status, ok, body } = await postJson(fetchImpl, OAUTH.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: `http://localhost:${port}/callback`,
    client_id: OAUTH.clientId,
    code_verifier: verifier,
    state,
  });
  if (!ok) {
    // 401 is how the server says "that code is not valid"; keep the two cases distinct.
    const kind = status === 401 ? 'invalid_code' : 'http_error';
    const err = new Error(`token exchange failed (${status})`);
    err.kind = kind;
    err.status = status;
    throw err;
  }
  return normalizeTokens(body, now);
}

/** Refresh an access token. The new refresh token replaces the old one (they rotate). */
async function refreshTokens({ refreshToken, scopes = DEFAULT_SCOPES, fetchImpl = fetch, now = Date.now }) {
  const { status, ok, body } = await postJson(fetchImpl, OAUTH.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH.clientId,
    scope: scopes.join(' '),
  });
  if (!ok) {
    const err = new Error(`token refresh failed (${status})`);
    err.kind = status === 400 || status === 401 ? 'invalid_refresh_token' : 'http_error';
    err.status = status;
    throw err;
  }
  const tokens = normalizeTokens(body, now);
  // Some responses omit the refresh token; keep using the old one rather than losing it.
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

/** True when the token is expired or about to be (default 5 minute margin). */
function needsRefresh(tokens, marginMs = 5 * 60 * 1000, now = Date.now) {
  if (!tokens || typeof tokens.expiresAt !== 'number') return false;
  return tokens.expiresAt - marginMs <= now();
}

/**
 * Run the interactive login.
 *
 * 1. listen on a loopback port,
 * 2. hand the authorize URL to `openBrowser`,
 * 3. wait for /callback?code=...&state=...,
 * 4. check `state`, exchange the code, answer the browser, resolve with the tokens.
 *
 * Rejects on timeout, a state mismatch, an `error=` callback, or a failed exchange. The
 * listener is always closed.
 */
function startLoginFlow({
  openBrowser,
  fetchImpl = fetch,
  scopes = DEFAULT_SCOPES,
  loginHint,
  timeoutMs = 5 * 60 * 1000,
  now = Date.now,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (typeof openBrowser !== 'function') throw new Error('openBrowser is required');
  const pkce = generatePkce(randomBytes);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const server = http.createServer();

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => fn(value));
      // Do not wait for keep-alive sockets: the browser may hold one open.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    };

    server.on('request', async (req, res) => {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; }
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      const reply = (status, text) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(text);
      };

      if (error) {
        reply(400, `Login was not completed: ${error}`);
        const err = new Error(`authorization refused: ${error}`);
        err.kind = 'refused';
        finish(reject, err);
        return;
      }
      if (!code || state !== pkce.state) {
        // A callback that does not carry OUR state is not ours -- never exchange it.
        reply(400, 'Invalid login callback.');
        const err = new Error('state mismatch');
        err.kind = 'state_mismatch';
        finish(reject, err);
        return;
      }

      try {
        const tokens = await exchangeCode({
          code, verifier: pkce.verifier, state: pkce.state,
          port: server.address().port, fetchImpl, now,
        });
        // Send the browser to Anthropic's own "you are signed in" page.
        res.writeHead(302, { location: OAUTH.successUrl });
        res.end();
        finish(resolve, tokens);
      } catch (err) {
        reply(502, 'Login failed. You can close this tab and try again.');
        finish(reject, err);
      }
    });

    server.on('error', (err) => finish(reject, err));

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      timer = setTimeout(() => {
        const err = new Error('login timed out');
        err.kind = 'timeout';
        finish(reject, err);
      }, timeoutMs);
      const authorizeUrl = buildAuthorizeUrl({ port, challenge: pkce.challenge, state: pkce.state, scopes, loginHint });
      Promise.resolve()
        .then(() => openBrowser(authorizeUrl))
        .catch((err) => finish(reject, err));
    });
  });
}

module.exports = {
  OAUTH,
  DEFAULT_SCOPES,
  generatePkce,
  buildAuthorizeUrl,
  normalizeTokens,
  exchangeCode,
  refreshTokens,
  needsRefresh,
  startLoginFlow,
};
