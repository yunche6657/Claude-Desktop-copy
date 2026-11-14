'use strict';

// Adapter for a host-owned plugin catalog. This is not a catalog, an OAuth
// implementation, or a verifier of renderer/CCB supplied URLs. The host must
// guarantee that every source snapshot is invalidated on ANY relevant change,
// including unobserved A -> B -> A, before publishing the changed state.
// Coverage means the host has resolved the active account and organization,
// installed/enabled plugin, effective server name and manifest URL, and all
// overriding/conflicting sources. These facts may not be inferred from status.
const coverage = ['account','organization','installation','enablement','manifest','effectiveServer','conflicts'];
const str = x => typeof x === 'string' && x.length > 0;
function createPluginAuthIssuer({getActor, getTenant, getSource} = {}) {
  if ([getActor,getTenant,getSource].some(f => typeof f !== 'function')) throw new TypeError('host authority callbacks required');
  const sessions = new Map();
  function state(id, actor) {
    let s = sessions.get(id);
    if (!s || s.token !== actor.actorToken || s.generation !== actor.generation) {
      s = { token:actor.actorToken, generation:actor.generation }; sessions.set(id,s);
    }
    return s;
  }
  function capture(id) {
    try {
      const a=getActor(id), t=getTenant(id);
      if (!a || !str(a.actorToken) || a.generation == null || !t || !str(t.accountId) || !str(t.organizationId)) return null;
      return {actorToken:a.actorToken,generation:a.generation,accountId:t.accountId,organizationId:t.organizationId};
    } catch { return null; }
  }
  function same(a,b) { return !!a && !!b && a.actorToken===b.actorToken && a.generation===b.generation && a.accountId===b.accountId && a.organizationId===b.organizationId; }
  function validUrl(value) {
    if (!str(value)) return false;
    try { const u=new URL(value); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
  }
  function read(id,name,ctx) {
    try {
      const s=getSource({sessionId:id,serverName:name,actorToken:ctx.actorToken,generation:ctx.generation,accountId:ctx.accountId,organizationId:ctx.organizationId});
      if (!s || s.complete!==true || !s.coverage || coverage.some(k => s.coverage[k]!==true) || !str(s.revision) || typeof s.isCurrent !== 'function' || s.isCurrent()!==true || s.accountId!==ctx.accountId || s.organizationId!==ctx.organizationId || !Array.isArray(s.servers)) return null;
      const rows=s.servers.filter(x => x?.serverName===name);
      if (rows.length!==1) return null;
      const row=rows[0];
      if (!str(row.pluginId) || row.enabled!==true || row.effective!==true || !validUrl(row.url)) return null;
      return {source:s,revision:s.revision,pluginId:row.pluginId,url:row.url};
    } catch { return null; }
  }
  function issueVerified({sessionId,serverName,actorToken,generation} = {}) {
    if (!str(sessionId) || !str(serverName) || !str(actorToken) || generation == null) return null;
    const ctx=capture(sessionId);
    if (!ctx || ctx.actorToken!==actorToken || ctx.generation!==generation) return null;
    const owner=state(sessionId,ctx), source=read(sessionId,serverName,ctx);
    if (!source) return null;
    let invalid=false;
    const isCurrent=() => {
      if (invalid) return false;
      try {
        if (sessions.get(sessionId)!==owner || !same(ctx,capture(sessionId)) || source.source.isCurrent()!==true) return !(invalid=true);
        const now=read(sessionId,serverName,ctx);
        if (!now || now.revision!==source.revision || now.pluginId!==source.pluginId || now.url!==source.url || !same(ctx,capture(sessionId)) || sessions.get(sessionId)!==owner || source.source.isCurrent()!==true) return !(invalid=true);
        return true;
      } catch { invalid=true; return false; }
    };
    return isCurrent() ? Object.freeze({url:source.url,isCurrent}) : null;
  }
  function retireSession(id) { return sessions.delete(id); }
  return Object.freeze({issueVerified,retireSession});
}
module.exports = { createPluginAuthIssuer };
