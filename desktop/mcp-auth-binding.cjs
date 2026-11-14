'use strict';

// This registry has no renderer or MCP status input. Its issuer callbacks must
// be private host-owned authority checks; installing one does not implement OAuth.
const { normalizeUrl } = require('./mcp-session-verbs.cjs');
const mismatch = "This session's copy of the connector points at a different server URL than the one shown here. Open a Code session where the org-installed plugin is loaded.";
const missing = "This session's server config doesn't match the plugin. Open a Code session in a folder where this plugin is enabled.";
const changed = "This server's configuration changed since sign-in started. Try signing in again.";
function validateBindingUrl(expected, actual, kind = 'verified') {
  if (expected && actual && normalizeUrl(actual) === normalizeUrl(expected)) return null;
  if (kind === 'config-auth') return changed;
  return expected && actual ? mismatch : missing;
}

function createMcpAuthBindingRegistry({ getActor, issueVerified, issueConfigAuth } = {}) {
  if (typeof getActor !== 'function') throw new TypeError('getActor is required');
  const sessions = new Map(), snapshots = new WeakMap();
  const validKey = x => typeof x === 'string' && x.length > 0;
  const actorOf = id => { try { const actor = getActor(id); return actor && { actorToken:actor.actorToken, generation:actor.generation }; } catch { return null; } };
  function sameActor(id, actor) {
    const now = actorOf(id);
    return !!now && now.actorToken === actor.actorToken && now.generation === actor.generation;
  }
  function actorValid(actor) {
    return !!actor && validKey(actor.actorToken) && actor.generation !== null && actor.generation !== undefined;
  }
  function stateFor(id, actor) {
    let state = sessions.get(id);
    if (!state || state.token !== actor.actorToken || state.generation !== actor.generation) {
      state = { token:actor.actorToken, generation:actor.generation, entries:new Map() };
      sessions.set(id, state);
    }
    return state;
  }
  function current(id, state, actor) { return sessions.get(id) === state && sameActor(id, actor); }
  function entryCurrent(id, state, actor, name, entry) {
    if (!current(id, state, actor) || state.entries.get(name) !== entry || entry.invalid) return false;
    if (entry.proof) {
      try { if (entry.proof.isCurrent() !== true) entry.invalid = true; }
      catch { entry.invalid = true; }
    }
    return !entry.invalid && current(id, state, actor) && state.entries.get(name) === entry;
  }
  function get(id, name, token) {
    if (!validKey(id) || !validKey(name)) return null;
    const actor = actorOf(id);
    if (!actorValid(actor) || actor.actorToken !== token) return null;
    const state = stateFor(id, actor);
    let entry = state.entries.get(name);
    if (!entry) { entry = { kind:'none' }; state.entries.set(name, entry); }
    if (!entryCurrent(id, state, actor, name, entry)) return null;
    const result = { kind:entry.kind, isCurrent:() => entryCurrent(id, state, actor, name, entry) };
    if (entry.url !== undefined) result.url = entry.url;
    snapshots.set(result, { id, name, state, actor, entry });
    return Object.freeze(result);
  }
  // The issuer receives only the identity and server name, never a caller URL.
  // It returns a private, revocable source proof established by the host.
  function establish(kind, id, name, token) {
    const issuer = kind === 'verified' ? issueVerified : issueConfigAuth;
    if (!validKey(id) || !validKey(name) || typeof issuer !== 'function') return false;
    const actor = actorOf(id);
    if (!actorValid(actor) || actor.actorToken !== token) return false;
    const state = stateFor(id, actor), before = state.entries.get(name);
    let proof;
    try { proof = issuer({ sessionId:id, serverName:name, actorToken:token, generation:actor.generation }); }
    catch { return false; }
    if (!proof || typeof proof.url !== 'string' || !proof.url || typeof proof.isCurrent !== 'function') return false;
    let live;
    try { live = proof.isCurrent() === true; } catch { return false; }
    if (!live || !current(id, state, actor) || state.entries.get(name) !== before) return false;
    state.entries.set(name, { kind, url:proof.url, proof });
    return true;
  }
  function revoke(id, name, token) {
    if (!validKey(id) || !validKey(name)) return false;
    const actor = actorOf(id);
    if (!actorValid(actor) || actor.actorToken !== token) return false;
    const state = stateFor(id, actor);
    if (!current(id, state, actor)) return false;
    state.entries.set(name, { kind:'none' });
    return true;
  }
  function retireSession(id) { return sessions.delete(id); }
  function resetConfigAuth(id, name, token, generation) {
    if (!validKey(id) || !validKey(name)) return false;
    const actor = actorOf(id);
    if (!actorValid(actor) || actor.actorToken !== token || actor.generation !== generation) return false;
    const state = stateFor(id, actor), entry = state.entries.get(name);
    // Even an invalid verified proof must not be silently replaced by a
    // config-only authentication attempt.
    if (!current(id, state, actor) || entry?.kind === 'verified') return false;
    state.entries.set(name, { kind:'none' });
    return true;
  }
  function completeReconnect(id, name, token, binding) {
    const snapshot = binding && snapshots.get(binding);
    if (!snapshot || snapshot.id !== id || snapshot.name !== name || snapshot.actor.actorToken !== token || snapshot.entry.kind !== 'config-auth' || !entryCurrent(id, snapshot.state, snapshot.actor, name, snapshot.entry)) return false;
    return revoke(id, name, token);
  }
  return Object.freeze({ get, establishVerified:(id,name,token) => establish('verified',id,name,token),
    establishConfigAuth:(id,name,token) => establish('config-auth',id,name,token), revoke, resetConfigAuth, retireSession, completeReconnect });
}
module.exports = { createMcpAuthBindingRegistry, validateBindingUrl };
