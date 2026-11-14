// Subscription account store + sign-in glue.
//
// Sits between the OAuth flow (oauth-login.cjs) and the bridge. Responsibilities:
//   * map OAuth failures to the `errorKind` strings the shipped sign-in UI switches on
//     (shared-1 eH(): ERR_PKCE_CALLBACK_TIMEOUT, ERR_PKCE_ACCESS_DENIED, ...),
//   * persist signed-in accounts, MORE THAN ONE, with exactly one active,
//   * hand out a fresh access token, refreshing it when it is about to expire.
//
// Storage is a single JSON file written atomically (temp + rename). Tokens are credentials:
// the file is created with mode 0600 where the platform supports it, and nothing here ever
// logs or returns a token except through `getActiveAccessToken`.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE_VERSION = 1;

/**
 * Map a login failure onto the UI's errorKind.
 *
 * The UI treats ERR_CANCELLED as "say nothing", so a user closing the tab must map to it
 * rather than to a generic failure. Keep this a pure function: it is the contract with the
 * frontend and the easiest thing to get subtly wrong.
 */
function errorKindFor(err) {
  const kind = err && err.kind;
  switch (kind) {
    case 'timeout': return 'ERR_PKCE_CALLBACK_TIMEOUT';
    case 'refused': {
      // `error=access_denied` is the user clicking "Deny"; anything else is the provider's own error.
      return /access_denied/.test(String(err.message || '')) ? 'ERR_PKCE_ACCESS_DENIED' : 'ERR_PKCE_AUTHORIZE_ERROR';
    }
    case 'state_mismatch': return 'ERR_PKCE_NO_CODE';
    case 'invalid_code': return 'ERR_FAILED';
    case 'cancelled': return 'ERR_CANCELLED';
    case 'http_error': return 'ERR_NETWORK';
    default: break;
  }
  // Node socket errors from the loopback listener.
  if (err && err.code === 'EADDRINUSE') return 'ERR_SIGN_IN_PORT_IN_USE';
  if (err && (err.code === 'EACCES' || err.code === 'EADDRNOTAVAIL')) return 'ERR_SIGN_IN_PORT_UNAVAILABLE';
  if (err && (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.name === 'TypeError')) {
    return 'ERR_NETWORK';
  }
  return 'ERR_FAILED';
}

function createAccountStore({
  filePath,
  oauth = require('./oauth-login.cjs'),
  fetchImpl = (...a) => fetch(...a),
  now = Date.now,
  randomUUID = crypto.randomUUID,
} = {}) {
  if (!filePath) throw new Error('filePath is required');

  const empty = () => ({ version: STORE_VERSION, activeId: null, accounts: [] });
  // Refresh tokens can be single-use. Share a refresh for the same account and
  // credential generation within this store instance.
  const refreshes = new Map();

  const load = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) return empty();
      return { version: STORE_VERSION, revision: raw.revision || null, selectionRevision: raw.selectionRevision || null, activeId: raw.activeId || null, accounts: raw.accounts.filter((a) => a && a.id) };
    } catch { return empty(); }
  };

  const save = (state) => {
    const previous = load();
    const selection = s => {
      const active = s.accounts.find(a => a.id === s.activeId);
      return JSON.stringify([s.activeId, active?.accountUuid ?? null, active?.activeOrganizationUuid || active?.organizationUuid || null]);
    };
    state.selectionRevision = selection(previous) === selection(state) ? previous.selectionRevision || null : randomUUID();
    state.revision = randomUUID();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  };

  /** What the UI may see: never the tokens. */
  const publicView = (a, activeId) => ({
    id: a.id,
    label: a.label,
    email: a.email || null,
    organizationName: a.organizationName || null,
    scopes: a.scopes || [],
    source: a.source || 'oauth',
    addedAt: a.addedAt,
    expiresAt: a.expiresAt ?? null,
    active: a.id === activeId,
  });

  const list = () => { const s = load(); return s.accounts.map((a) => publicView(a, s.activeId)); };

  // Only expose the active identity, never the account's token material.
  const getActiveIdentity = () => {
    const state = load();
    const account = state.accounts.find(a => a.id === state.activeId);
    const orgId = account && (account.activeOrganizationUuid || account.organizationUuid);
    if (!account || typeof account.accountUuid !== 'string' || !account.accountUuid ||
        typeof orgId !== 'string' || !orgId) return null;
    return { accountId: account.accountUuid, orgId };
  };

  const getActiveIdentitySnapshot = () => {
    const state = load();
    const account = state.accounts.find(a => a.id === state.activeId);
    const orgId = account && (account.activeOrganizationUuid || account.organizationUuid);
    if (!account || typeof account.accountUuid !== 'string' || !account.accountUuid ||
        typeof orgId !== 'string' || !orgId) return null;
    const accountId = account.accountUuid;
    const storeId = account.id;
    const revision = state.revision || null;
    let valid = true;
    return { accountId, orgId, isCurrent() {
      if (!valid) return false;
      const latest = load();
      const active = latest.accounts.find(a => a.id === latest.activeId);
      valid = latest.activeId === storeId && (latest.revision || null) === revision &&
        active?.accountUuid === accountId && (active?.activeOrganizationUuid || active?.organizationUuid) === orgId;
      return valid;
    } };
  };

  const getActiveAccountContext = () => {
    const state = load();
    const account = state.accounts.find(a => a.id === state.activeId);
    if (!account || typeof account.accountUuid !== 'string' || !account.accountUuid) return null;
    return { accountId: account.accountUuid, storeId: account.id, revision: state.revision || null };
  };

  /** Add (or update, matched on e-mail / account uuid) an account from a token set. */
  const upsertFromTokens = (tokens, { label, source = 'oauth', makeActive = true } = {}) => {
    const state = load();
    const email = tokens.account && tokens.account.email ? tokens.account.email : null;
    const accountUuid = tokens.account && tokens.account.uuid ? tokens.account.uuid : null;
    const existing = (accountUuid && state.accounts.find(a => a.accountUuid === accountUuid)) ||
      (email && state.accounts.find(a => a.email === email && !a.accountUuid));
    const orgId = tokens.organization && tokens.organization.uuid;
    const knownOrganizations = new Set(existing?.knownOrganizations || []);
    if (existing?.organizationUuid) knownOrganizations.add(existing.organizationUuid);
    if (orgId) knownOrganizations.add(orgId);
    const record = {
      id: existing ? existing.id : `acct_${randomUUID()}`,
      label: label || (existing && existing.label) || email || 'Claude account',
      email,
      accountUuid,
      organizationName: tokens.organization ? tokens.organization.name : existing?.organizationName || null,
      organizationUuid: tokens.organization ? tokens.organization.uuid : existing?.organizationUuid || null,
      activeOrganizationUuid: orgId || existing?.activeOrganizationUuid || existing?.organizationUuid || null,
      knownOrganizations: [...knownOrganizations],
      accessToken: Object.hasOwn(tokens, 'accessToken') ? tokens.accessToken : existing?.accessToken,
      refreshToken: Object.hasOwn(tokens, 'refreshToken') ? tokens.refreshToken :
        (Object.hasOwn(tokens, 'accessToken') && tokens.accessToken !== existing?.accessToken ? null : existing?.refreshToken),
      expiresAt: Object.hasOwn(tokens, 'expiresAt') ? tokens.expiresAt : existing?.expiresAt,
      scopes: tokens.scopes || existing?.scopes || [],
      source,
      addedAt: existing ? existing.addedAt : now(),
    };
    if (existing) state.accounts[state.accounts.indexOf(existing)] = record;
    else state.accounts.push(record);
    if (makeActive || !state.activeId) state.activeId = record.id;
    save(state);
    return publicView(record, state.activeId);
  };

  // This only changes local selection; it does not establish token authorization for an org.
  const setActiveOrganization = (accountId, orgId) => {
    const state = load();
    const account = state.accounts.find(a => a.id === state.activeId);
    if (!account || !accountId || account.accountUuid !== accountId || typeof orgId !== 'string' || !orgId) return false;
    const known = new Set(account.knownOrganizations || []);
    if (account.organizationUuid) known.add(account.organizationUuid);
    if (!known.has(orgId)) return false;
    account.activeOrganizationUuid = orgId;
    save(state);
    return true;
  };

  const setActive = (id) => {
    const state = load();
    if (!state.accounts.some((a) => a.id === id)) return false;
    state.activeId = id;
    save(state);
    return true;
  };

  const remove = (id) => {
    const state = load();
    const before = state.accounts.length;
    state.accounts = state.accounts.filter((a) => a.id !== id);
    if (state.accounts.length === before) return false;
    // Never leave `activeId` pointing at nothing while accounts remain.
    if (state.activeId === id) state.activeId = state.accounts.length ? state.accounts[0].id : null;
    save(state);
    return true;
  };

  /**
   * A usable access token for the active account, refreshed when needed.
   * Returns null when there is no active account or the refresh was rejected.
   */
  const getActiveAccessToken = async () => {
    const state = load();
    const account = state.accounts.find((a) => a.id === state.activeId);
    if (!account) return null;
    if (!oauth.needsRefresh({ expiresAt: account.expiresAt }, undefined, now)) return account.accessToken;
    if (!account.refreshToken) return null;
    let pending = refreshes.get(account.id);
    if (!pending || pending.accessToken !== account.accessToken ||
        pending.refreshToken !== account.refreshToken || pending.expiresAt !== account.expiresAt) {
      pending = { accessToken: account.accessToken, refreshToken: account.refreshToken, expiresAt: account.expiresAt };
      pending.promise = (async () => {
        try {
          const fresh = await oauth.refreshTokens({ refreshToken: account.refreshToken, scopes: account.scopes && account.scopes.length ? account.scopes : undefined, fetchImpl, now });
          const latest = load();
          const target = latest.accounts.find((a) => a.id === account.id);
          // Persist a rotated grant even after selection changes; discard it only
          // if the account or its credentials were replaced while in flight.
          if (!target || target.accessToken !== account.accessToken || target.refreshToken !== account.refreshToken ||
              target.expiresAt !== account.expiresAt) return null;
          target.accessToken = fresh.accessToken;
          target.refreshToken = fresh.refreshToken;
          target.expiresAt = fresh.expiresAt;
          save(latest);
          return fresh;
        } catch { return null; }
      })();
      refreshes.set(account.id, pending);
      pending.promise.finally(() => { if (refreshes.get(account.id) === pending) refreshes.delete(account.id); });
    }
    const fresh = await pending.promise;
    if (!fresh) return null;
    const latest = load();
    const target = latest.accounts.find(a => a.id === account.id);
    // Each caller independently checks its original selection after the shared refresh.
    if (latest.activeId !== account.id || latest.selectionRevision !== state.selectionRevision ||
        !target || target.accessToken !== fresh.accessToken || target.refreshToken !== fresh.refreshToken ||
        target.expiresAt !== fresh.expiresAt) return null;
    return fresh.accessToken;
  };

  /** Interactive sign-in; resolves with {ok:true,account} or {ok:false,errorKind}. */
  const signIn = async ({ openBrowser, loginHint, timeoutMs, label } = {}) => {
    try {
      const tokens = await oauth.startLoginFlow({ openBrowser, fetchImpl, loginHint, timeoutMs, now });
      return { ok: true, account: upsertFromTokens(tokens, { label, source: 'oauth' }) };
    } catch (err) {
      return { ok: false, errorKind: errorKindFor(err) };
    }
  };

  return { list, getActiveIdentity, getActiveIdentitySnapshot, getActiveAccountContext, setActiveOrganization, upsertFromTokens, setActive, remove, getActiveAccessToken, signIn, filePath };
}

module.exports = { createAccountStore, errorKindFor, STORE_VERSION };
