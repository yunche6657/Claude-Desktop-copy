'use strict';
const { normalizeUrl } = require('./mcp-session-verbs.cjs');
const { validateBindingUrl } = require('./mcp-auth-binding.cjs');

// All dependencies are host-owned. In particular status must originate from the
// current CCB actor, not the renderer, and getActor includes session generation.
function createMcpSessionAuth(deps = {}) {
  const entries = new Map(), locks = new Map();
  const statuses = new Set(['needs-auth', 'failed', 'connected']);
  const transports = new Set(['http', 'sse']);
  const err = error => ({ error });
  const gone = () => err('Session not running');
  const unavailable = () => err('MCP session state unavailable');
  const changed = () => err("This server's configuration changed since sign-in started. Try signing in again.");
  const key = (id, name) => JSON.stringify([id, name]);
  const actor = id => { try { return deps.getActor?.(id); } catch { return null; } };
  function context(id) {
    const a = actor(id);
    if (!a || typeof a.actorToken !== 'string' || !a.actorToken || a.generation == null) return null;
    return { ...a, current: () => { const b = actor(id); return !!b && a.actorToken === b.actorToken && a.generation === b.generation; } };
  }
  function revision(id, name, ctx) {
    try { const v = deps.getConfigRevision?.(id,name,ctx.actorToken,ctx.generation); return (typeof v === 'string' && v.length > 0) || Number.isSafeInteger(v) ? v : undefined; } catch { return undefined; }
  }
  function bindingAllowed(id,name,ctx) {
    try { const b=deps.getAuthBinding?.(id,name,ctx.actorToken); return !!b && ['none','config-auth'].includes(b.kind) && typeof b.isCurrent === 'function' && b.isCurrent() === true; } catch { return false; }
  }
  function resetConfigAuth(id,name,ctx) {
    try { return deps.resetConfigAuth?.(id,name,ctx.actorToken,ctx.generation) === true; } catch { return false; }
  }
  function configBinding(id,name,ctx) {
    try { const b=deps.getAuthBinding?.(id,name,ctx.actorToken); return b?.kind === 'config-auth' && typeof b.isCurrent === 'function' && b.isCurrent() === true ? b : null; } catch { return null; }
  }
  function verifiedBinding(id,name,ctx) {
    try { const b=deps.getAuthBinding?.(id,name,ctx.actorToken); return b?.kind === 'verified' && typeof b.isCurrent === 'function' && b.isCurrent() === true ? b : null; } catch { return null; }
  }
  function validBinding(binding) { try { return binding?.isCurrent() === true; } catch { return false; } }
  function current(id, name, ctx, entry) {
    return !entry.invalid && ctx.current() && entry.ctx.actorToken === ctx.actorToken && entry.ctx.generation === ctx.generation && entries.get(key(id, name)) === entry && entry.revision !== undefined && revision(id,name,ctx) === entry.revision;
  }
  function acquire(id,name,ctx) { const k=JSON.stringify([id,name,ctx.actorToken,ctx.generation]); if (locks.has(k)) return null; const lock={key:k,pending:false,finished:false}; locks.set(k,lock); return lock; }
  function finish(id,name,lock) { lock.finished=true; if (!lock.pending && locks.get(lock.key)===lock) locks.delete(lock.key); }
  function dispatch(id,name,lock,work) {
    lock.pending=true;
    return Promise.resolve().then(work).finally(() => { lock.pending=false; if (lock.finished && locks.get(lock.key)===lock) locks.delete(lock.key); });
  }
  function rows(value, ctx) { return value?.actorToken === ctx.actorToken && Array.isArray(value.servers) ? value.servers : null; }
  function one(list, name) {
    const matches = list.filter(x => x?.name === name);
    if (!matches.length) return err('Unknown MCP server for this session');
    if (matches.length !== 1) return err('Ambiguous MCP server for this session');
    return matches[0];
  }
  function gate(row, allowMissingTransport = true) {
    if (!statuses.has(row.status)) return err(`Server status: ${row.status}`);
    if ((!allowMissingTransport || row.transport !== undefined) && !transports.has(row.transport)) return err("This server doesn't support signing in from here");
    return null;
  }
  function safeError(e) {
    try { const s = deps.formatError?.(e); return typeof s === 'string' && s ? s : 'MCP control failed'; }
    catch { return 'MCP control failed'; }
  }
  const timeout = Symbol('timeout');
  async function deadline(work, ms) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(work), new Promise(resolve => { timer = setTimeout(() => resolve(timeout), Math.max(0, ms)); timer.unref?.(); })]); }
    finally { clearTimeout(timer); }
  }
  const now = () => Date.now();
  const duration = () => deps.timeoutMs ?? 60000;
  async function refresh(id, ctx) {
    const result = await deps.refreshStatus(id, ctx.actorToken);
    return ctx.current() ? rows(result, ctx) : null;
  }
  function local(id) { try { return deps.isLocal?.(id); } catch { return undefined; } }
  function waiting(id) { try { return deps.controlRequestsWait?.(id); } catch { return undefined; } }
  async function waitOrQueueClear(id,name,ctx) {
    const wait=waiting(id);
    if (wait===false) return null;
    if (wait!==true) return unavailable();
    if (typeof deps.queue !== 'function') return err('Turn in progress');
    const queued=await deps.queue({sessionId:id,serverName:name,verb:'mcpClearAuth',actorToken:ctx.actorToken,generation:ctx.generation,origin:'dialog'});
    if (!ctx.current()) return gone();
    return queued===true ? {queued:true,error:'Turn in progress'} : err('Turn in progress');
  }
  async function mcpAuthenticateConfigServer(id, name) {
    const ctx = context(id); if (!ctx) return gone();
    if (local(id) !== true) return local(id) === false ? err("Remote sessions aren't supported for this flow.") : unavailable();
    if (typeof deps.authenticate !== 'function' || typeof deps.refreshStatus !== 'function') return unavailable();
    const initial = rows(deps.getStatus?.(id), ctx); if (!initial) return unavailable();
    const old = one(initial, name); if (!old.name) return old;
    const denial = gate(old); if (denial) return denial;
    const rev = revision(id,name,ctx); if (rev === undefined) return unavailable();
    const lock = acquire(id,name,ctx); if (!lock) return err('MCP control in progress');
    if (!resetConfigAuth(id,name,ctx) || !bindingAllowed(id,name,ctx)) { finish(id,name,lock); return err("Couldn't verify server config. Click Connect first."); }
    const k = key(id, name), marker = { ctx, revision:rev, pending:true }, end = now() + duration(); entries.set(k, marker);
    try {
      const fresh = await deadline(() => refresh(id, ctx), end - now());
      if (fresh === timeout) return err('Sign-in timed out');
      if (!ctx.current()) return gone();
      if (!current(id,name,ctx,marker) || !bindingAllowed(id,name,ctx)) return changed();
      if (!fresh) return err("Couldn't verify server config");
      const row = one(fresh, name);
      if (!row.name) return err('Server status: unknown');
      if (!statuses.has(row.status)) return err(`Server status: ${row.status}`);
      if (row.status === 'connected' && old.status !== 'connected') return err('Server status: connected');
      const url = row.config?.url, transport = row.config?.type;
      if (typeof url !== 'string' || !url || !transports.has(transport)) return err("This server doesn't support signing in from here");
      marker.url = url;
      const result = await deadline(() => dispatch(id,name,lock,() => current(id,name,ctx,marker) && bindingAllowed(id,name,ctx) ? deps.authenticate(id, ctx.actorToken, name) : null), end - now());
      if (result === timeout) return err('Sign-in timed out');
      if (!ctx.current()) return gone();
      if (!current(id,name,ctx,marker) || !bindingAllowed(id,name,ctx) || result?.actorToken !== ctx.actorToken) return changed();
      if (result.requiresUserAction === true && typeof result.flowId === 'string' && result.flowId && typeof result.authUrl === 'string' && result.authUrl) {
        marker.flowId = result.flowId; marker.pending = false;
        return { authUrl:result.authUrl, error:undefined, callbackExpected:undefined, redirectScheme:undefined, state:undefined };
      }
      if (result.requiresUserAction === false) {
        marker.pending = false;
        return { authUrl:undefined, error:undefined, callbackExpected:undefined, redirectScheme:undefined, state:undefined };
      }
      entries.delete(k); return err('MCP control failed');
    } catch (e) { if (entries.get(k) === marker) entries.delete(k); return ctx.current() ? err(safeError(e)) : gone(); }
    finally { if (entries.get(k) === marker && marker.pending) entries.delete(k); finish(id,name,lock); }
  }
  // The renderer URL is a claim checked against a fresh, actor-bound status.
  // Only the host may wire getPluginAuthProof into its private registry issuer.
  // This reproduces the original trust boundary; it is not catalog evidence.
  async function mcpAuthenticate(id, name, manifestUrl) {
    const ctx = context(id); if (!ctx) return gone();
    if (local(id) !== true) return local(id) === false ? err("Remote sessions aren't supported for this flow.") : unavailable();
    if (typeof deps.authenticate !== 'function' || typeof deps.refreshStatus !== 'function' || typeof deps.establishVerified !== 'function') return unavailable();
    const initial = rows(deps.getStatus?.(id),ctx); if (!initial) return unavailable();
    const old = one(initial,name); if (!old.name) return old;
    const denial = gate(old); if (denial) return denial;
    const rev = revision(id,name,ctx); if (rev === undefined) return unavailable();
    const lock = acquire(id,name,ctx); if (!lock) return err('MCP control in progress');
    const k=key(id,name), previous=entries.get(k), marker={ctx,revision:rev,pending:true,kind:'verified'}, end=now()+duration();
    const beforeCommit=()=>ctx.current() && revision(id,name,ctx)===rev && entries.get(k)===previous;
    try {
      const fresh=await deadline(() => refresh(id,ctx),end-now());
      if (fresh===timeout) return err('Sign-in timed out');
      if (!ctx.current()) return gone();
      if (!beforeCommit()) return changed();
      if (!fresh) return err("Couldn't verify server config");
      const row=one(fresh,name);
      if (!row.name) return err('Server status: unknown');
      if (!statuses.has(row.status)) return err(`Server status: ${row.status}`);
      if (row.status==='connected' && old.status!=='connected') return err('Server status: connected');
      if (!transports.has(row.config?.type)) return err("This server doesn't support signing in from here");
      const mismatch=validateBindingUrl(manifestUrl,row.config?.url);
      if (mismatch) return err(mismatch);
      marker.url=manifestUrl; marker.preflight=true; entries.set(k,marker);
      if (deps.establishVerified(id,name,ctx.actorToken)!==true) return err("Couldn't verify server config. Click Connect first.");
      const binding=verifiedBinding(id,name,ctx);
      if (!binding || validateBindingUrl(manifestUrl,binding.url) || !current(id,name,ctx,marker)) return err("Couldn't verify server config. Click Connect first.");
      const result=await deadline(() => dispatch(id,name,lock,() => current(id,name,ctx,marker) && validBinding(binding) ? deps.authenticate(id,ctx.actorToken,name) : null),end-now());
      if (result===timeout) { marker.pending=false; return err('Sign-in timed out'); }
      if (!ctx.current()) return gone();
      if (!current(id,name,ctx,marker) || !validBinding(binding) || result?.actorToken!==ctx.actorToken) return changed();
      if (result.requiresUserAction===true && typeof result.flowId==='string' && result.flowId && typeof result.authUrl==='string' && result.authUrl) {
        marker.flowId=result.flowId; marker.pending=false;
        return {authUrl:result.authUrl,error:undefined,callbackExpected:undefined,redirectScheme:undefined,state:undefined};
      }
      if (result.requiresUserAction===false) {
        marker.pending=false;
        return {authUrl:undefined,error:undefined,callbackExpected:undefined,redirectScheme:undefined,state:undefined};
      }
      marker.pending=false; return err('MCP control failed');
    } catch(e) { if (entries.get(k)===marker && marker.preflight) marker.pending=false; return ctx.current() ? err(safeError(e)) : gone(); }
    finally { if (entries.get(k)===marker && marker.pending) entries.delete(k); finish(id,name,lock); }
  }
  async function mcpSubmitOAuthCallbackUrl(id, name, callbackUrl) {
    const ctx = context(id); if (!ctx) return gone();
    const k = key(id,name), entry = entries.get(k);
    if (!entry || entry.pending || entry.consumed || !entry.flowId || !current(id,name,ctx,entry)) return err("Couldn't verify server config. Click Connect first.");
    const binding = entry.kind === 'verified' ? verifiedBinding(id,name,ctx) : configBinding(id,name,ctx); if (!binding) return err("Couldn't verify server config. Click Connect first.");
    if (typeof callbackUrl !== 'string' || !callbackUrl || typeof deps.submitCallback !== 'function' || typeof deps.refreshStatus !== 'function') return unavailable();
    const lock = acquire(id,name,ctx); if (!lock) return err('MCP control in progress');
    const end = now() + duration();
    try {
      const fresh = await deadline(() => refresh(id,ctx), end - now());
      if (fresh === timeout) return err('Sign-in timed out');
      if (!current(id,name,ctx,entry) || !validBinding(binding)) return ctx.current() ? changed() : gone();
      if (!fresh) return err("Couldn't verify server config");
      const row = one(fresh,name);
      if (!row.name || typeof row.config?.url !== 'string' || normalizeUrl(row.config.url) !== normalizeUrl(entry.url)) return changed();
      const result = await deadline(() => dispatch(id,name,lock,() => {
        if (!current(id,name,ctx,entry) || !validBinding(binding)) return null;
        entry.consumed = true;
        return deps.submitCallback(id,ctx.actorToken,name,entry.flowId,callbackUrl);
      }), end - now());
      if (result === timeout) return err('Sign-in timed out');
      if (!current(id,name,ctx,entry) || !validBinding(binding) || result?.actorToken !== ctx.actorToken) return ctx.current() ? changed() : gone();
      return { error:undefined };
    } catch (e) {
      // A shared-gate refusal proves the callback was not sent to CCB.
      if (['MCP_CONTROL_BUSY','MCP_CONTROL_UNCERTAIN'].includes(e?.code) && current(id,name,ctx,entry)) entry.consumed=false;
      return ctx.current() ? err(safeError(e)) : gone();
    }
    finally { finish(id,name,lock); }
  }
  async function mcpClearAuth(id,name) {
    const ctx = context(id); if (!ctx) return gone();
    if (local(id) !== true) return local(id) === false ? err("Remote sessions aren't supported for this flow.") : unavailable();
    if (typeof deps.clear !== 'function' || typeof deps.refreshStatus !== 'function') return unavailable();
    const initial = rows(deps.getStatus?.(id),ctx); if (!initial) return unavailable();
    const row = one(initial,name); if (!row.name) return row;
    const denied = gate(row,false); if (denied) return denied;
    const initialWait=await waitOrQueueClear(id,name,ctx);if(initialWait)return initialWait;
    const rev = revision(id,name,ctx); if (rev === undefined) return unavailable();
    const lock = acquire(id,name,ctx); if (!lock) return err('MCP control in progress');
    // Preserve the existing proof while clear is in flight. The host revokes
    // the registry binding only after a successful clear response.
    const k = key(id,name), previous = entries.get(k), end = now() + duration();
    const stillCurrent = () => ctx.current() && revision(id,name,ctx)===rev && entries.get(k)===previous;
    try {
      const fresh = await deadline(() => refresh(id,ctx), end - now());
      if (fresh === timeout) return err("Clear authentication didn't start");
      if (!ctx.current()) return gone();
      if (!stillCurrent()) return changed();
      if (!fresh) return err("Couldn't verify server config");
      const latest = one(fresh,name);
      if (!latest.name) return err('Unknown MCP server for this session');
      if (!statuses.has(latest.status)) return err(`Server status: ${latest.status}`);
      const queued=await waitOrQueueClear(id,name,ctx);if(queued)return queued;
      const result = await deadline(() => dispatch(id,name,lock,() => {
        if (!stillCurrent()) return null;
        if (waiting(id)!==false) return {waiting:true};
        return deps.clear(id,ctx.actorToken,name);
      }), end - now());
      if (result === timeout) return err('Clear authentication timed out');
      if (result?.waiting) return await waitOrQueueClear(id,name,ctx) ?? unavailable();
      if (!ctx.current()) return gone();
      if (!stillCurrent() || result?.actorToken !== ctx.actorToken) return changed();
      entries.delete(k);
      return {};
    } catch(e) { return ctx.current() ? err(safeError(e)) : gone(); }
    finally { finish(id,name,lock); }
  }
  // Private registry issuer input: the URL is derived from the successful
  // renderer-claim/status comparison, never passed into the issuer itself.
  // A fresh status poll is still mandatory for every privileged operation.
  function getPluginAuthProof({sessionId,serverName,actorToken,generation} = {}) {
    const ctx=context(sessionId), entry=entries.get(key(sessionId,serverName));
    if (!ctx || ctx.actorToken!==actorToken || ctx.generation!==generation || !entry || entry.kind!=='verified' || entry.preflight!==true || !entry.url || !current(sessionId,serverName,ctx,entry)) return null;
    const isCurrent=() => {
      let valid=current(sessionId,serverName,ctx,entry);
      if (valid) {
        const list=rows(deps.getStatus?.(sessionId),ctx), matches=list?.filter(row=>row?.name===serverName);
        valid=matches?.length===1 && !validateBindingUrl(entry.url,matches[0]?.config?.url);
      }
      if (!valid) entry.invalid=true;
      return valid===true;
    };
    return isCurrent() ? Object.freeze({url:entry.url,isCurrent}) : null;
  }
  // Used only by the host's private binding issuer. No URL comes from callers.
  function getConfigAuthProof({sessionId,serverName,actorToken,generation}) {
    const ctx = context(sessionId), entry = entries.get(key(sessionId,serverName));
    if (!ctx || ctx.actorToken !== actorToken || ctx.generation !== generation || !entry || entry.pending || !entry.url || !current(sessionId,serverName,ctx,entry)) return null;
    const isCurrent = () => {
      let valid = current(sessionId,serverName,ctx,entry);
      if (valid) {
        const list = rows(deps.getStatus?.(sessionId),ctx);
        const matches = list?.filter(row => row?.name === serverName);
        valid = matches?.length === 1 && typeof matches[0].config?.url === 'string' && normalizeUrl(matches[0].config.url) === normalizeUrl(entry.url);
      }
      if (!valid) entry.invalid = true;
      return valid === true;
    };
    return isCurrent() ? { url:entry.url, isCurrent } : null;
  }
  function invalidate(id, name, token, generation) {
    const ctx = context(id);
    if (!ctx || ctx.actorToken !== token || ctx.generation !== generation) return false;
    return entries.delete(key(id,name));
  }
  function retireSession(id) { for (const [k,e] of entries) if (JSON.parse(k)[0] === id) entries.delete(k); }
  return Object.freeze({mcpAuthenticate,mcpAuthenticateConfigServer,mcpSubmitOAuthCallbackUrl,mcpClearAuth,getConfigAuthProof,getPluginAuthProof,invalidate,retireSession});
}
module.exports = { createMcpSessionAuth };
