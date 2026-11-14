'use strict';
// Native Etn orchestration. Validation/consent belongs to the caller; raw JSON
// is never labelled an applied configuration by this module.
// Native Bs uses noon Pacific time for support-end dates, including DST.
function supportEndTime(value) {
  if(typeof value !== 'string') throw new Error('invalid deprecation date');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(!match) throw new Error('invalid deprecation date');
  const [, yearText, monthText, dayText] = match;
  const year=Number(yearText), month=Number(monthText)-1, day=Number(dayText);
  let timestamp=Date.UTC(year,month,day,20);
  const date=new Date(timestamp);
  if(date.getUTCFullYear()!==year || date.getUTCMonth()!==month || date.getUTCDate()!==day) throw new Error('invalid deprecation date');
  const sunday=(monthIndex,first)=>{const base=Date.UTC(year,monthIndex,first);return base+(7-new Date(base).getUTCDay())%7*86400000;};
  const midnight=Date.UTC(year,month,day);
  if(midnight>=sunday(2,8) && midnight<sunday(10,1)) timestamp-=3600000;
  return timestamp;
}
function crossedSupportEnd(previous, now) {
  return (previous.keyedParseErrors || []).some(entry=>{
    if(entry.kind!=='deprecated' || entry.deprecation?.supportEnds===undefined) return false;
    try {const end=supportEndTime(entry.deprecation.supportEnds);return previous.fetchedAt<end && end<=now;} catch {return false;}
  });
}
function createHybridBootstrapFetch({resolveAuth, fetch, primeMemberships = () => {}, primeModels = () => {}, onUnauthorized = () => {}, validate, now = Date.now}) {
  if(typeof resolveAuth !== 'function' || typeof fetch !== 'function' || typeof validate !== 'function') throw new TypeError('bootstrap dependencies required');
  let generation=0;
  function invalidate(){generation++;}
  async function run(url,{previous, trustedDelivery=false, background=false}={}) {
    const epoch=generation, started=now();let origin;
    try { origin=new URL(url).origin; } catch { return {ok:false,kind:'parse',detail:'invalid URL'}; }
    const current=()=>epoch===generation;
    let auth;try{auth=await resolveAuth(url,{background,isCurrent:current});}catch{return {ok:false,kind:'unreachable'};}
    if(!current())return {ok:false,kind:'stale'};
    if(!auth?.ok) {
      if(auth?.kind==='stale')return {ok:false,kind:'stale'};
      if(auth?.kind==='auth')return {ok:false,kind:'auth'};
      if(auth?.kind==='parse')return {ok:false,kind:'parse',...(auth.detail!==undefined?{detail:auth.detail}:{})};
      return {ok:false,kind:'unreachable',...(auth?.detail!==undefined?{detail:auth.detail}:{}),...(auth?.retryAt!==undefined?{retryAt:auth.retryAt}:{})};
    }
    const {bearer,oidc}=auth;
    if(bearer && oidc?.apiOrigin) {
      Promise.resolve().then(()=>current()&&primeMemberships(oidc.apiOrigin,bearer,!!oidc.xAuthorization,oidc.orgUuid?{bootstrapUrl:url}:undefined)).catch(()=>{});
      if(oidc.orgUuid)Promise.resolve().then(()=>current()&&primeModels({apiOrigin:oidc.apiOrigin,bearer,orgUuid:oidc.orgUuid,xAuthorization:!!oidc.xAuthorization})).catch(()=>{});
    }
    const headers=new Headers(auth.headers || {});
    if(previous?.sourceUrl!==undefined && previous.sourceUrl!==url) previous=undefined;
    const useEtag=previous?.etag!==undefined && !crossedSupportEnd(previous,now());
    if(useEtag)headers.set('If-None-Match',previous.etag);
    let response;try{response=await fetch(url,{headers,cache:'no-store',signal:AbortSignal.timeout(30000)});}catch{return {ok:false,kind:'unreachable'};}
    if(!current())return {ok:false,kind:'stale'};
    if(response.status===304 && useEtag && previous)return {ok:true,value:previous.value,suppliedKeys:previous.suppliedKeys,warnings:[],keyedParseErrors:previous.keyedParseErrors,fetchedAt:started,etag:previous.etag,notModified:true,sourceUrl:url,trustedDelivery};
    if(!response.ok) {
      if(response.status===401) {
        if(!background && current() && (oidc || bearer !== undefined)) {
          try { await onUnauthorized({oidc,bearer,isCurrent:current}); } catch { return {ok:false,kind:'unreachable'}; }
          if(!current())return {ok:false,kind:'stale'};
        }
        return {ok:false,kind:'auth',status:response.status};
      }
      return {ok:false,kind:'http',status:response.status};
    }
    let text;try{text=(await response.text()).trim();}catch{return {ok:false,kind:'unreachable'};}
    let body;try{body=JSON.parse(text);}catch{return {ok:false,kind:'parse',status:response.status,detail:'response is not a JSON object'};}
    if(!body || typeof body!=='object' || Array.isArray(body))return {ok:false,kind:'parse',status:response.status,detail:'response is not a JSON object'};
    if(!current())return {ok:false,kind:'stale'};
    return validate({json:body,bootstrapUrl:url,trustedOrigin:origin,oidc,hybrid:true,trustedDelivery,now:started,etag:response.headers.get('etag')??undefined,respStatus:response.status,isCurrent:current});
  }
  return {run,invalidate};
}
module.exports={createHybridBootstrapFetch, supportEndTime, crossedSupportEnd};
