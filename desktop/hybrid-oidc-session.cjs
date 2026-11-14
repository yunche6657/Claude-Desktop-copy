'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EARLY_MS = 60000, COOLDOWN_MS = 300000;

// vQn/Wze/Cl: deployment-specific public OAuth settings are supplied by the host.
const OAUTH_CONFIG = Object.freeze({
  production: Object.freeze({apiHost:'https://api.anthropic.com',clientId:'eecb31a3-ffc9-4391-83ba-d63733df2f47'}),
  staging: Object.freeze({apiHost:'https://api-staging.anthropic.com',clientId:'104f6bf0-7787-407c-a39c-69f7005305aa'}),
});
const DEFAULT_SCOPES = 'user:profile org:desktop_config';
function deriveHybridOidc(bootstrapUrl, options = {}) {
  const bootstrap = new URL(bootstrapUrl);
  const selected = bootstrap.origin === OAUTH_CONFIG.staging.apiHost ? OAUTH_CONFIG.staging : OAUTH_CONFIG.production;
  const apiOrigin = new URL(options.apiHost ?? selected.apiHost).origin;
  const clientId = options.clientId ?? selected.clientId, scopes = options.scopes ?? DEFAULT_SCOPES;
  if (typeof clientId !== 'string' || !clientId || typeof scopes !== 'string') throw new TypeError('OAuth clientId and scopes are required');
  let orgUuid;
  const match = /^\/v1\/desktop\/orgs\/([^/]+)\/bootstrap\/?$/.exec(bootstrap.pathname);
  if (match) { try { const decoded = decodeURIComponent(match[1]); if (UUID.test(decoded)) orgUuid = decoded.toLowerCase(); } catch {} }
  const authorizationUrl = new URL('/oauth/authorize', options.authorizationOrigin ?? 'https://claude.ai');
  if (orgUuid) authorizationUrl.searchParams.set('orgUUID', orgUuid);
  return { clientId, authorizationUrl:authorizationUrl.toString(), tokenUrl:`${apiOrigin}/v1/oauth/token`, scopes,
    apiOrigin, orgUuid, storeKey:`hybrid:${bootstrap.origin}:${orgUuid ?? 'unknown'}`,
    xAuthorization:options.xAuthorization ?? (selected !== OAUTH_CONFIG.production), anthropicTokenEndpoint:true };
}

// Storage is an injected slot adapter. It must isolate this store from other OAuth stores;
// this module never reads files, environment credentials or interactive auth state.
function createHybridOidcSession({ storage, fetch: fetchImpl, now = Date.now, random = Math.random } = {}) {
  if (!storage || typeof storage.read !== 'function' || typeof storage.write !== 'function') throw new TypeError('slot storage read/write required');
  if (typeof fetchImpl !== 'function') throw new TypeError('refresh transport required');
  const memory = new Map(), reads = new Map(), locks = new Map(), backs = new Map();
  let generation = 0, rejectedRefresh, cooldownUntil = 0;
  const auth = () => ({ok:false,kind:'auth'}), unreachable = () => ({ok:false,kind:'unreachable'});
  const active = until => until > now() && until-now() <= COOLDOWN_MS;
  async function read(key) {
    if (memory.has(key)) return memory.get(key);
    const epoch = generation;
    let pending = reads.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => storage.read(key)).finally(() => { if (reads.get(key) === pending) reads.delete(key); });
      reads.set(key,pending);
    }
    const value = await pending;
    if (value && epoch === generation) memory.set(key,value);
    return value;
  }
  function serial(key, fn) {
    const prior=locks.get(key) ?? Promise.resolve();
    const result=prior.catch(()=>{}).then(fn);
    const held=result.finally(()=>{if(locks.get(key)===held) locks.delete(key);});
    locks.set(key,held);return held;
  }
  function retryAfter(response) {
    const text=response.headers?.get?.('retry-after'); if(!text)return;
    const n=Number(text);if(Number.isFinite(n))return n>0?n*1000:undefined;
    const t=Date.parse(text);return Number.isFinite(t)&&t>now()?t-now():undefined;
  }
  async function refresh(cred) {
    const request={grant_type:'refresh_token',refresh_token:cred.refreshToken,client_id:cred.clientId};
    if(cred.clientSecret)request.client_secret=cred.clientSecret;
    if(cred.grantedScopes?.length)request.scope=cred.grantedScopes.join(' ');
    let response;
    try { response=await fetchImpl(cred.tokenUrl,{method:'POST',credentials:'omit',headers:{'anthropic-version':'2023-06-01','Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(30000)}); }
    catch { return {ok:false}; }
    if(!response.ok) {
      let body;try{body=JSON.parse(await response.text());}catch{}
      const rate=response.status===429||response.status===503;
      return {ok:false,invalidGrant:body?.error==='invalid_grant',terminal:response.status>=400&&response.status<500&&!rate,
        ...(rate?{rateLimited:{retryAfterMs:retryAfter(response)}}:{})};
    }
    let data;try{data=await response.json();}catch{return {ok:false};}
    if(!data?.access_token)return {ok:false};
    const next={accessToken:data.access_token,refreshToken:data.refresh_token??cred.refreshToken,idToken:data.id_token??cred.idToken,
      expiresAt:now()+(typeof data.expires_in==='number'?data.expires_in*1000:3600000),
      grantedScopes:data.scope?data.scope.split(/[\s,]+/).filter(Boolean):cred.grantedScopes,
      requestedScopes:cred.requestedScopes,grantedAt:cred.grantedAt,
      refreshTokenExpiresAt:(()=>{const t=data.refresh_token_expires_in??data.refresh_expires_in;return typeof t==='number'&&t>0?now()+t*1000:data.refresh_token?undefined:cred.refreshTokenExpiresAt;})(),
      tokenUrl:cred.tokenUrl,clientId:cred.clientId,clientSecret:cred.clientSecret};
    return {ok:true,cred:next};
  }
  // The real adapter is synchronous and shares one slot instance with login.
  const sameCredential=(current,cred)=>!!current && current.accessToken===cred.accessToken && current.refreshToken===cred.refreshToken;
  async function matchesSlotAsync(key,cred,epoch) {
    if(epoch!==generation)return false;
    const current=await storage.read(key);
    return epoch===generation && sameCredential(current,cred);
  }
  function commitGuard(key,cred,epoch) {
    if(epoch!==generation)return false;
    const current=storage.read(key);
    // Async adapters require their own isCurrent check at the commit boundary.
    if(current && typeof current.then==='function') { current.catch(()=>{}); return epoch===generation; }
    return sameCredential(current,cred);
  }
  async function refreshSlot(key, tokenGeneration, {background=true}={}) {
    return serial(key,async()=>{
      if(tokenGeneration!==generation)return auth();
      const cred=await read(key);
      if(tokenGeneration!==generation)return auth();
      if(cred?.accessToken && (cred.expiresAt===undefined || cred.expiresAt>now()+EARLY_MS))return {ok:true,bearer:cred.accessToken};
      let temporary=false, retryAt, back=backs.get(key), outcome;
      if(cred?.refreshToken && back && active(back.notBefore)) { temporary=true; retryAt=back.notBefore; }
      else if(cred?.refreshToken) {
        outcome=await refresh(cred);
        if(!await matchesSlotAsync(key,cred,tokenGeneration))return auth();
        if(outcome.rateLimited) {
          const consecutive=(back?.consecutive??0)+1, retry=outcome.rateLimited.retryAfterMs;
          const exp=Math.min(1000*2**Math.max(0,consecutive-1),32000);
          const wait=retry!==undefined?Math.min(retry,COOLDOWN_MS):Math.min(Math.round(exp*(1+random())),COOLDOWN_MS);
          backs.set(key,{notBefore:now()+wait,consecutive});
        } else backs.delete(key);
        if(outcome.ok) {
          try{await storage.write(key,outcome.cred,{isCurrent:()=>commitGuard(key,cred,tokenGeneration)});}catch(error){if(!error?.credentialRetained)return auth();}
          if(tokenGeneration===generation)memory.set(key,outcome.cred);
          if(tokenGeneration!==generation)return auth();
          return {ok:true,bearer:outcome.cred.accessToken};
        }
        if(outcome.invalidGrant) {
          if (!background) {
            if (typeof storage.delete !== 'function') return {ok:false,kind:'auth',slotRemoval:'unavailable'};
            const deleted=await storage.delete(key,{isCurrent:()=>commitGuard(key,cred,tokenGeneration)}); if(deleted===false)return auth(); memory.delete(key);
          }
          return auth();
        }
        temporary=!outcome.terminal;
      }
      if(cred?.accessToken && (cred.expiresAt===undefined || cred.expiresAt>now()))return {ok:true,bearer:cred.accessToken};
      return temporary ? (retryAt === undefined ? unreachable() : {ok:false,kind:'unreachable',retryAt}) : auth();
    });
  }
  async function getBearer(oidc) {
    if(!oidc || typeof oidc.storeKey!=='string' || !oidc.storeKey)throw new TypeError('OIDC storeKey required');
    const epoch=generation, cred=await read(oidc.storeKey);
    if(epoch!==generation)return auth();
    if(cred?.accessToken && (cred.expiresAt===undefined || cred.expiresAt>now()+EARLY_MS))return {ok:true,bearer:cred.accessToken};
    if(!cred?.accessToken || !cred.refreshToken || cred.refreshToken===rejectedRefresh)return auth();
    if(active(cooldownUntil))return unreachable();
    const result=await refreshSlot(oidc.storeKey,epoch);
    if(epoch!==generation)return auth();
    if(!result.ok && result.kind==='auth') { rejectedRefresh=cred.refreshToken; return result; }
    if(!result.ok || result.bearer===cred.accessToken) { cooldownUntil=now()+COOLDOWN_MS;return unreachable(); }
    return result;
  }
  // Ctn uses Ptn directly, including after Jtn clears the old access token.
  // getBearer above intentionally retains Ltn's stricter old-access requirement.
  async function getBootstrapBearer(oidc, {background=false}={}) {
    if(!oidc || typeof oidc.storeKey!=='string' || !oidc.storeKey)throw new TypeError('OIDC storeKey required');
    return refreshSlot(oidc.storeKey,generation,{background});
  }
  // Caller captures epoch and the exact bearer when dispatching the request.
  // An unproven or obsolete 401 must never mutate the current grant.
  async function rejectAccess(oidc, {bearer,epoch}={}) {
    if(!oidc || typeof oidc.storeKey!=='string' || !oidc.storeKey)throw new TypeError('OIDC storeKey required');
    if(typeof bearer!=='string'||!bearer||!Number.isInteger(epoch))return {ok:false,kind:'unproven'};
    const key=oidc.storeKey;
    if(epoch!==generation)return {ok:false,kind:'stale'};
    const initial=storage.read(key);
    if(!initial || typeof initial.then === 'function' || initial.accessToken!==bearer)return {ok:false,kind:'stale'};
    invalidate(); epoch=generation;
    return serial(key,async()=>{
      if(epoch!==generation)return {ok:false,kind:'stale'};
      const cred=await storage.read(key);
      if(epoch!==generation || !cred || cred.accessToken!==bearer)return {ok:false,kind:'stale'};
      const guard=()=>commitGuard(key,cred,epoch);
      if(!guard())return {ok:false,kind:'stale'};
      if(!cred.refreshToken) {
        if(typeof storage.delete!=='function')return {ok:false,kind:'delete-unavailable'};
        const deleted=await storage.delete(key,{isCurrent:guard});
        if(epoch!==generation||deleted===false)return {ok:false,kind:'stale'};
        invalidate(); return {ok:true,kind:'deleted'};
      }
      const replacement={...cred,accessToken:'',expiresAt:undefined};
      try { await storage.write(key,replacement,{isCurrent:guard}); }
      catch(error) { if(!error?.credentialRetained)return {ok:false,kind:'stale'}; }
      if(epoch!==generation)return {ok:false,kind:'stale'};
      invalidate(); memory.set(key,replacement); return {ok:true,kind:'cleared'};
    });
  }
  const captureEpoch=()=>generation;
  function invalidate() { generation++; memory.clear(); reads.clear(); backs.clear(); rejectedRefresh=undefined; cooldownUntil=0; }
  return {getBearer,getBootstrapBearer,rejectAccess,captureEpoch,invalidate};
}
module.exports={deriveHybridOidc,createHybridOidcSession};
