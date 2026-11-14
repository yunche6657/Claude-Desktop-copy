'use strict';

// Session/actor ownership, status, queue and URL binding are supplied by the
// host. A missing or indeterminate dependency never grants a control request.
const allowedScopes = new Set(['local','user','project','flag','enterprise','managed','agent']);
const managedPolicy = /\bmanaged (?:MCP )?policy\b/i;
const TIMEOUT = Symbol('mcp-verb-timeout');
function normalizeUrl(value) {
  try { const url = new URL(value); url.pathname = url.pathname.replace(/\/$/, '') || '/'; return url.href; }
  catch { return value; }
}
function validateEnable(rows, name) {
  const found = rows.filter(row => row.name === name);
  if (!found.length) return { error:'Unknown MCP server for this session' };
  if (found.length !== 1) return { error:"This server can't be turned on from here" };
  const row = found[0];
  if (row.status === 'failed' && typeof row.error === 'string' && managedPolicy.test(row.error)) return { error:'Server status: failed', errorCode:'managed_policy' };
  if (row.status !== 'disabled') return null;
  if (row.origin !== undefined || row.transport === 'claudeai-proxy' || row.scope === undefined) return { error:"This server can't be turned on from here" };
  if (!allowedScopes.has(row.scope) && !(row.scope === 'dynamic' && /^plugin:[^:]+:.+$/.test(row.name))) return { error:"This server can't be turned on from here" };
  return null;
}

function createMcpSessionVerbs(deps = {}) {
  const inFlight = new Map();
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || setTimeout, clearTimer = deps.clearTimer || clearTimeout;
  const error = message => ({ error:message });
  const sessionGone = () => error('Session not running');
  const unavailable = () => error('MCP session state unavailable');
  async function deadline(work, ms) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise(resolve => { timer = setTimer(() => resolve(TIMEOUT), Math.max(0, ms)); timer?.unref?.(); })]);
    } finally { if (timer !== undefined) clearTimer(timer); }
  }
  function context(id) {
    if (typeof deps.getSession !== 'function' || typeof deps.getActorToken !== 'function' || typeof deps.getSessionGeneration !== 'function') return null;
    const session = deps.getSession(id), token = deps.getActorToken(id), generation = deps.getSessionGeneration(id);
    if (!session || typeof token !== 'string' || !token || generation === undefined || generation === null) return null;
    const current = () => !!deps.getSession(id) && deps.getActorToken(id) === token && deps.getSessionGeneration(id) === generation;
    return { session, token, generation, current };
  }
  function rowsFor(id, ctx) {
    const status = deps.getStatus?.(id);
    return status?.actorToken === ctx.token && Array.isArray(status.servers) ? status.servers : null;
  }
  async function waitOrQueue(id, name, verb, ctx) {
    const waits = deps.controlRequestsWait?.(id);
    if (waits !== true && waits !== false) return unavailable();
    if (!waits) return null;
    if (typeof deps.queue !== 'function') return error('Turn in progress');
    const accepted = await deps.queue({ sessionId:id, serverName:name, verb, actorToken:ctx.token, generation:ctx.generation });
    if (!ctx.current()) return sessionGone();
    return accepted === true ? { queued:true, error:'Turn in progress' } : error('Turn in progress');
  }
  function one(rows, name) {
    const found = rows.filter(row => row && row.name === name);
    if (!found.length) return error('Unknown MCP server for this session');
    if (found.length !== 1) return error('Ambiguous MCP server for this session');
    return found[0];
  }
  function bindingFor(id, name, ctx) {
    const binding = deps.getAuthBinding?.(id, name, ctx.token);
    if (!binding || !['verified','config-auth','unverified','none'].includes(binding.kind) || typeof binding.isCurrent !== 'function' || binding.isCurrent() !== true) return null;
    return binding;
  }
  function bindingCurrent(binding) { try { return binding.isCurrent() === true; } catch { return false; } }
  function verifyUrl(row, binding, verb) {
    if (binding.kind !== 'verified' && !(verb === 'mcpReconnect' && binding.kind === 'config-auth')) return null;
    const actual = row?.config?.url;
    if (binding.kind === 'config-auth' && (!binding.url || !actual || normalizeUrl(actual) !== normalizeUrl(binding.url))) return "This server's configuration changed since sign-in started. Try signing in again.";
    if (typeof binding.url !== 'string' || !binding.url || typeof actual !== 'string' || !actual) return "This session's server config doesn't match the plugin. Open a Code session in a folder where this plugin is enabled.";
    if (normalizeUrl(actual) !== normalizeUrl(binding.url)) return "This session's copy of the connector points at a different server URL than the one shown here. Open a Code session where the org-installed plugin is loaded.";
    return null;
  }
  async function freshRows(id, ctx, ms) {
    if (typeof deps.refreshStatus !== 'function') return null;
    const result = await deadline(() => deps.refreshStatus(id, ctx.token), ms);
    if (result === TIMEOUT) return TIMEOUT;
    if (!ctx.current()) return null;
    return result?.actorToken === ctx.token && Array.isArray(result.servers) ? result.servers : null;
  }
  function displayError(err) {
    if (typeof deps.formatError !== 'function') return 'MCP control failed';
    try { const value = deps.formatError(err); return typeof value === 'string' && value ? value : 'MCP control failed'; }
    catch { return 'MCP control failed'; }
  }
  async function invoke(verb, id, name, origin = 'dialog') {
    if (typeof name !== 'string' || !name) return error('Unknown MCP server for this session');
    const ctx = context(id);
    if (!ctx) return sessionGone();
    const supported = deps.isSupportedSession?.(id, ctx.session);
    if (supported === undefined) return unavailable();
    if (supported !== true) return error("Remote sessions aren't supported for this flow.");
    if (ctx.session.backend?.remoteTarget !== undefined || ctx.session.remoteTarget !== undefined) return error("Remote sessions aren't supported for this flow.");
    const rows = rowsFor(id, ctx);
    if (!rows) return unavailable();
    const row = one(rows, name);
    if (row.error && !row.name) return row;
    if (verb === 'mcpEnableServer') {
      const denied = validateEnable(rows, name); if (denied) return denied;
      if (typeof deps.toggle !== 'function') return error('SDK does not support toggleMcpServer');
    } else {
      if (verb === 'mcpRetryConnection') {
        if (row.status === 'connected') return {};
        if (row.status !== 'failed' && row.status !== 'needs-auth') return error(`Server status: ${row.status}`);
      }
      if (typeof deps.reconnect !== 'function') return error('SDK does not support reconnectMcpServer');
    }
    let binding;
    if (verb !== 'mcpEnableServer') {
      binding = bindingFor(id, name, ctx);
      if (!binding) return error("Couldn't verify server config. Click Connect first.");
      if (verb === 'mcpReconnect' && binding.kind !== 'verified' && binding.kind !== 'config-auth') return error("Couldn't verify server config. Click Connect first.");
    }
    const key = `${id}\0${name}`;
    let marker;
    try {
      let queued = await waitOrQueue(id, name, verb, ctx); if (queued) return queued;
      const end = now() + 60000;
      const fresh = verb === 'mcpRetryConnection' && binding.kind !== 'verified' ? rows : await freshRows(id, ctx, end - now());
      if (fresh === TIMEOUT) return error(verb === 'mcpEnableServer' ? "Turn on didn't start" : "Reconnect didn't start");
      if (!ctx.current()) return sessionGone();
      if (!fresh) return error("Couldn't verify server config");
      const latest = one(fresh, name); if (latest.error && !latest.name) return latest;
      if (verb === 'mcpEnableServer') { const denied = validateEnable(fresh, name); if (denied) return denied; }
      else {
        if (!bindingCurrent(binding)) return error("Couldn't verify server config. Click Connect first.");
        const denied = verifyUrl(latest, binding, verb); if (denied) return error(denied);
        if (verb === 'mcpRetryConnection' && latest.status === 'connected') return {};
        if (verb === 'mcpRetryConnection' && latest.status !== 'failed' && latest.status !== 'needs-auth') return error(`Server status: ${latest.status}`);
      }
      if (verb !== 'mcpRetryConnection' || binding.kind === 'verified') {
        queued = await waitOrQueue(id, name, verb, ctx); if (queued) return queued;
      }
      if (verb === 'mcpRetryConnection') {
        if (inFlight.has(key)) return error('Already reconnecting');
        marker = Symbol(verb); inFlight.set(key, marker);
      }
      if (!ctx.current()) return sessionGone();
      if (binding && !bindingCurrent(binding)) return error("Couldn't verify server config. Click Connect first.");
      const remaining = end - now();
      if (remaining <= 0) return error(verb === 'mcpEnableServer' ? "Turn on didn't start" : "Reconnect didn't start");
      let controlError;
      const result = await deadline(() => {
        if (!ctx.current()) return { stale:true };
        if (binding && !bindingCurrent(binding)) return { bindingStale:true };
        if (deps.controlRequestsWait?.(id) !== false) return { waiting:true };
        return verb === 'mcpEnableServer' ? deps.toggle(id, ctx.token, name, true) : deps.reconnect(id, ctx.token, name);
      }, remaining).catch(err => {
        if (verb !== 'mcpEnableServer' || ['MCP_CONTROL_BUSY','MCP_CONTROL_UNCERTAIN','CCB_CONTROL_TIMEOUT'].includes(err?.code)) throw err;
        controlError = err; return { actorToken:ctx.token };
      });
      if (result === TIMEOUT) return error(verb === 'mcpEnableServer' ? 'Turn on timed out' : 'Reconnect timed out');
      if (result?.waiting) return await waitOrQueue(id, name, verb, ctx) ?? unavailable();
      if (result?.bindingStale) return error("Couldn't verify server config. Click Connect first.");
      if (!ctx.current() || result?.actorToken !== ctx.token) return sessionGone();
      if (binding && !bindingCurrent(binding)) return error("Couldn't verify server config. Click Connect first.");
      const confirmation = await freshRows(id, ctx, verb === 'mcpRetryConnection' ? Math.max(0, end - now()) : 5000);
      if (!ctx.current()) return sessionGone();
      if (verb === 'mcpEnableServer') {
        const raw = controlError instanceof Error ? controlError.message : String(controlError);
        const policy = controlError !== undefined && raw.startsWith('MCP server ') && raw.endsWith(' is blocked by enterprise managed policy');
        const status = Array.isArray(confirmation) ? confirmation.find(row => row?.name === name)?.status : undefined;
        if (controlError === undefined) return status === 'disabled' ? error('Server status: disabled') : {};
        if (!policy && (confirmation === TIMEOUT || !confirmation)) return error('Turn on timed out');
        if (policy || status === undefined || status === 'disabled') return { error:displayError(controlError), ...(policy ? { errorCode:'managed_policy' } : {}) };
        return {};
      }
      if (confirmation === TIMEOUT || (!confirmation && verb !== 'mcpRetryConnection')) return error('Reconnect timed out');
      const confirmed = confirmation?.find(row => row?.name === name);
      if (confirmed?.status && confirmed.status !== 'connected') return error(confirmed.status === 'failed' && confirmed.error ? displayError(confirmed.error) : `Server status: ${confirmed.status}`);
      if (verb === 'mcpReconnect' && binding.kind === 'config-auth') {
        if (!bindingCurrent(binding)) return error("Couldn't verify server config. Click Connect first.");
        deps.completeReconnect?.(id, name, ctx.token, binding);
      }
      return {};
    } catch (err) { return ctx.current() ? error(displayError(err)) : sessionGone(); }
    finally { if (inFlight.get(key) === marker) inFlight.delete(key); }
  }
  return {
    mcpReconnect:(id, name) => invoke('mcpReconnect', id, name).catch(unavailable),
    mcpRetryConnection:(id, name, origin) => invoke('mcpRetryConnection', id, name, origin).catch(unavailable),
    mcpEnableServer:(id, name) => invoke('mcpEnableServer', id, name).catch(unavailable),
  };
}
module.exports = { createMcpSessionVerbs, normalizeUrl, validateEnable };
