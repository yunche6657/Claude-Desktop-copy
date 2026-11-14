'use strict';
const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');
const REMOTE_ID=/^(?:session_|cse_)([A-Za-z0-9_]{1,64})$/;
const BLOCKED=new Set(['category1','category2','category_org_blocked']);
const PAGE_TOOLS=new Set(['preview_start','navigate','read_page','computer','form_input','find','get_page_text','javascript_tool','read_console_messages','read_network_requests','resize_window','request_access','browser_batch']);
const TAB_TOOLS=new Set(['tabs_context','tabs_create','tabs_select','tabs_close']);
const canonicalRemoteId=value=>typeof value==='string'&&REMOTE_ID.test(value)?'session_'+REMOTE_ID.exec(value)[1]:null;
function httpOrigin(value){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;let host=url.hostname.replace(/\.+$/,'').toLowerCase();const mapped=/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);if(mapped){const a=parseInt(mapped[1],16),b=parseInt(mapped[2],16);host=[a>>8,a&255,b>>8,b&255].join('.');}if(host.startsWith('www.')&&host.split('.').length>=3&&!host.endsWith('.local'))host=host.slice(4);if(!host||host.startsWith('.'))return null;return url.protocol+'//'+host+(url.port?':'+url.port:'');}catch{return null;}}
function safeUrl(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
function toolName(value){return typeof value==='string'?value.replace(/^(?:mcp__Claude_Browser__|mcp__Claude_Preview__|mcp__Claude_in_Chrome__)/,''):null;}
function createPreviewAccess({getPreviewHost,getSession=()=>null,getRemoteSession=async()=>null,
  featureEnabled=()=>false,getPolicy=async()=>({available:false}),classifyOrigin=async()=>({kind:'error'}),
  readAllowedOrigins=null,writeAllowedOrigins=null,consumeUserGesture=()=>false,
  getStandingReadPermission=async()=>false,getCurrentStamp=null,isWorkspaceTrusted=()=>false,now=Date.now}={}){
  if(typeof getPreviewHost!=='function')throw new TypeError('getPreviewHost is required');
  const contexts=new Map(),pending=new Map(),once=new Map(),remembered=new Set(),browserServers=new Map(),tabAdmissions=new Map();
  let disposed=false,generation=0,counter=0;
  const readsEnabled=()=>{try{return !disposed&&featureEnabled()===true;}catch{return false;}};
  const gesture=sender=>{try{return consumeUserGesture(sender)===true;}catch{return false;}};
  const deny=message=>({kind:'deny',message});
  const key=(id,origin)=>id+'\0'+origin;
  async function policy(){try{const current=await getPolicy();return current&&current.available===true?current:null;}catch{return null;}}
  async function remote(id){const canonical=canonicalRemoteId(id);if(!canonical)return null;try{const session=await getRemoteSession(canonical);return session&&session.verified===true&&session.halted!==true&&session.linkedThread!==true?{...session,sessionId:canonical}:null;}catch{return null;}}
  function hostTabs(serverId){try{return getPreviewHost()?.getPreviewTabs(serverId)||{tabs:[],activeTabId:'seed'};}catch{return{tabs:[],activeTabId:'seed'};}}
  function location(serverId,tabId){const state=hostTabs(serverId);const selected=tabId??state.activeTabId;const tab=state.tabs.find(tab=>tab.tabId===selected);if(!tab)return null;const url=tab.url||(selected===state.activeTabId?getPreviewHost()?.getPreviewUrl?.(serverId):null);return typeof url==='string'?{tabId:selected,url,origin:httpOrigin(url)}:null;}
  async function actualLocation(serverId,tabId){const result=location(serverId,tabId);if(result)return result;if(typeof getCurrentStamp==='function'){try{const value=await getCurrentStamp(serverId,tabId);if(value&&typeof value.url==='string')return{tabId:value.tabId,url:value.url,origin:httpOrigin(value.url)};}catch{}}return null;}
  async function stamp(serverId,tabId){if(typeof getCurrentStamp==='function'){try{const value=await getCurrentStamp(serverId,tabId);if(value)return structuredClone(value);}catch{return null;}}return location(serverId,tabId);}
  async function classify(url){try{const verdict=await classifyOrigin(url);return verdict?.kind==='ok'&&['category0','category1','category2','category3','category_org_blocked'].includes(verdict.category)?verdict:null;}catch{return null;}}
  async function knownOrigins(){try{const values=typeof readAllowedOrigins==='function'?await readAllowedOrigins():[...remembered];if(!Array.isArray(values))return null;return new Set(values.map(httpOrigin).filter(Boolean));}catch{return null;}}
  function liveContext(serverId){const ctx=contexts.get(serverId);return ctx&&ctx.remote===true&&serverId.startsWith('preview-remote-session_')?ctx:null;}
  async function startBrowserPreview(cwd,sessionId){
    if(!readsEnabled()||typeof sessionId!=='string'||!sessionId||typeof cwd!=='string'||!path.isAbsolute(cwd))return null;
    const epoch=generation,session=await getSession(sessionId);if(!session||!await isWorkspaceTrusted(cwd,session)||!await policy()||epoch!==generation)return null;
    const host=getPreviewHost();if(!host?.createPreview)return null;const previewId='preview-'+sessionId;
    const result=await host.createPreview(previewId,'about:blank',cwd,sessionId);if(!result||disposed||epoch!==generation){if(result)getPreviewHost()?.destroyPreview(previewId);return null;}
    if(!contexts.has(previewId)){const serverId='browser-preview-'+now()+'-'+counter++;contexts.set(previewId,{remote:false,sessionId,cwd});browserServers.set(serverId,{serverId,name:'Browser',sessionId,port:0,status:'running',startedAt:new Date(now()).toISOString(),cwd,previewId,tabId:result.tabId});}
    return previewId;
  }
  async function ensureRemoteBlankPreview(sessionId,requireCowork=false){
    if(!readsEnabled()||typeof requireCowork!=='boolean')return null;const epoch=generation;
    const identity=await remote(sessionId);if(!identity||!await policy()||epoch!==generation)return null;
    const id='preview-remote-'+identity.sessionId;const result=await getPreviewHost()?.createPreview(id,'about:blank',identity.cwd,identity.sessionId);
    if(!result||disposed||epoch!==generation){if(result)getPreviewHost()?.destroyPreview(id);return null;}
    contexts.set(id,{remote:true,sessionId:identity.sessionId,cwd:identity.cwd,requireCowork,identityEpoch:identity.identityEpoch});return id;
  }
  async function resolveRemotePaneConsent(query){
    if(!query||typeof query!=='object'||typeof query.sessionId!=='string'||typeof query.toolName!=='string'||query.tabId!==undefined&&typeof query.tabId!=='string'||query.url!==undefined&&typeof query.url!=='string'||query.neverSilent!==undefined&&typeof query.neverSilent!=='boolean')return deny('Invalid browser consent query.');
    if(!readsEnabled())return deny('The in-app browser is not enabled on this Desktop install.');
    const id=canonicalRemoteId(query.sessionId),name=toolName(query.toolName);if(!id)return deny('Invalid remote session id.');
    if(!PAGE_TOOLS.has(name)&&!TAB_TOOLS.has(name))return deny('That tool is not available for remote sessions on Desktop.');
    const epoch=generation,currentPolicy=await policy();if(!currentPolicy)return deny('Browser policy is temporarily unavailable.');
    if(currentPolicy.externalBrowsingDisabled===true)return deny("External browsing is disabled by your organization's policy.");
    if(TAB_TOOLS.has(name))return{kind:'allow'};
    const identity=await remote(id);if(!identity||epoch!==generation)return deny('This remote session could not be verified just now.');
    const serverId='preview-remote-'+id,ctx=liveContext(serverId);
    const nav=(name==='navigate'||name==='preview_start')&&typeof query.url==='string'?query.url.trim():'';
    if(name==='navigate'&&/^(back|forward)?$/i.test(nav))return{kind:'allow'};
    if(name==='preview_start'&&!nav)return deny('Dev servers are not available in this remote session; provide a URL.');
    if(name==='browser_batch')return ctx?{kind:'allow'}:deny('No browser pane is open for this session.');
    if(name==='request_access')return{kind:'card'};
    const where=ctx?await actualLocation(serverId,query.tabId):null;
    const url=nav?safeUrl(nav):where?.url,origin=httpOrigin(url);if(!origin)return deny('No site is open in this tab.');
    const verdict=await classify(url);if(!verdict||epoch!==generation||!readsEnabled())return deny('Site policy check is unavailable.');
    if(BLOCKED.has(verdict.category))return deny('This site cannot be used in the browser pane.');
    const origins=await knownOrigins();if(!origins)return deny('Allowed-site settings could not be read.');
    const token=once.get(key(id,origin));if(token!==undefined){once.delete(key(id,origin));if(now()-token.at<=120000&&token.generation===generation){if(token.perAction!==true)tabAdmissions.set(serverId+'\0'+(query.tabId??where?.tabId??'seed'),origin);return{kind:'allow'};}}
    const perAction=verdict.category==='category3';
    if(query.neverSilent!==true&&!perAction&&(origins.has(origin)||(!nav&&ctx&&where?.origin===origin&&tabAdmissions.get(serverId+'\0'+where.tabId)===origin)))return{kind:'allow'};
    const tabId=query.tabId??where?.tabId??'seed';const anchor=ctx?await stamp(serverId,tabId):null;
    if(disposed||epoch!==generation)return deny('Browser pane state was reset; retry.');
    const card={kind:'card',origin,tabId,perAction,reason:perAction?(verdict.privateNetworkOnly===true?'private_network':'high_risk'):'site'};
    pending.set(key(id,origin),{...card,serverId,sessionId:id,url,navigates:Boolean(nav),anchor,generation,createdAt:now()});return card;
  }
  async function pendingCard(sessionId,value){const id=canonicalRemoteId(sessionId),origin=httpOrigin(value);if(!id||!origin)return null;const card=pending.get(key(id,origin));if(!card||card.generation!==generation)return null;const identity=await remote(id);if(!identity||!readsEnabled())return null;const ctx=liveContext(card.serverId);const current=ctx?await stamp(card.serverId,card.tabId):null;if(!isDeepStrictEqual(current,card.anchor))return null;const currentPolicy=await policy(),verdict=await classify(card.url);if(!currentPolicy||currentPolicy.externalBrowsingDisabled===true||!verdict||BLOCKED.has(verdict.category)||(verdict.category==='category3')!==card.perAction)return null;return{card,identity,origin,id};}
  async function recordRemotePaneOriginDecision(sessionId,url,remember,sender){
    if(remember!==true||!readsEnabled()||!gesture(sender))return false;
    const state=await pendingCard(sessionId,url);if(!state||state.card.perAction||!state.card.navigates&&state.card.anchor===null)return false;
    if(typeof readAllowedOrigins==='function'&&typeof writeAllowedOrigins!=='function')return false;
    const {id,origin}=state;const epoch=generation,origins=await knownOrigins();if(!origins)return false;origins.add(origin);
    if(typeof writeAllowedOrigins==='function'){try{if(await writeAllowedOrigins([...origins])===false)return false;}catch{return false;}}
    if(disposed||epoch!==generation)return false;remembered.add(origin);pending.delete(key(id,origin));return true;
  }
  async function admitRemotePaneOriginOnce(sessionId,origin,sender){
    if(!readsEnabled()||!gesture(sender))return false;
    const state=await pendingCard(sessionId,origin);if(!state)return false;
    if(!state.card.perAction&&!state.card.navigates&&(await actualLocation(state.card.serverId,state.card.tabId))?.origin===state.origin)tabAdmissions.set(state.card.serverId+'\0'+state.card.tabId,state.origin);
    once.set(key(state.id,state.origin),{at:now(),generation,perAction:state.card.perAction});pending.delete(key(state.id,state.origin));return true;
  }
  async function authorizeRead(input){
    if(!readsEnabled()||!input||typeof input!=='object')return false;
    const captured=structuredClone(input),ctx=liveContext(captured.serverId),epoch=generation;
    if(!ctx||captured.sessionId!==ctx.sessionId||typeof captured.tabId!=='string'||!Array.isArray(captured.frames)||captured.frames.length===0||!Number.isFinite(captured.epoch))return false;
    const identity=await remote(ctx.sessionId);if(!identity||identity.identityEpoch!==ctx.identityEpoch)return false;
    const currentPolicy=await policy();if(!currentPolicy||currentPolicy.externalBrowsingDisabled===true)return false;
    const origin=httpOrigin(captured.url);if(!origin||httpOrigin(captured.origin)!==origin)return false;
    const actual=await actualLocation(captured.serverId,captured.tabId);if(!actual||actual.url!==captured.url)return false;
    const live=typeof getCurrentStamp==='function'?await stamp(captured.serverId,captured.tabId):null;
    if(live&&!isDeepStrictEqual(live,captured))return false;
    const urls=[captured.url,...captured.frames.map(frame=>frame?.url)];let requiresStanding=false;
    for(const url of urls){
      if(url===''||url==='about:blank'||url==='about:srcdoc'||typeof url==='string'&&url.startsWith('data:'))continue;
      if(typeof url!=='string')return false;
      if(url.startsWith('blob:')){if(httpOrigin(url.slice(5))!==origin)return false;continue;}
      const frameOrigin=httpOrigin(url);if(!frameOrigin)return false;
      const verdict=await classify(url);if(!verdict||BLOCKED.has(verdict.category))return false;
      if(verdict.category==='category3'){
        // Native M6i does not offer a per-action approval card for read-tier sinks.
        if(verdict.privateNetworkOnly!==true||frameOrigin!==origin)return false;requiresStanding=true;
      }
    }
    if(requiresStanding&&urls.some(url=>{if(!url||url==='about:blank'||url==='about:srcdoc'||url.startsWith('data:'))return false;return httpOrigin(url.startsWith('blob:')?url.slice(5):url)!==origin;}))return false;
    for(const tab of hostTabs(captured.serverId).tabs){const actualTab=await actualLocation(captured.serverId,tab.tabId);const url=actualTab?.url||tab.url||tab.origin;if(!httpOrigin(url))continue;const verdict=await classify(url);if(!verdict||BLOCKED.has(verdict.category))return false;}
    if(requiresStanding){try{if(await getStandingReadPermission(captured)!==true)return false;}catch{return false;}}
    const afterPolicy=await policy();if(!afterPolicy||afterPolicy.externalBrowsingDisabled===true||afterPolicy.epoch!==currentPolicy.epoch||disposed||epoch!==generation||!readsEnabled()||!await remote(ctx.sessionId))return false;
    const afterIdentity=await remote(ctx.sessionId);if(!afterIdentity||afterIdentity.identityEpoch!==identity.identityEpoch)return false;
    const afterLocation=await actualLocation(captured.serverId,captured.tabId);if(!afterLocation||afterLocation.url!==captured.url)return false;
    if(typeof getCurrentStamp==='function'){const after=await stamp(captured.serverId,captured.tabId);if(!isDeepStrictEqual(after,captured))return false;}
    return true;
  }
  function revokeSession(sessionId){const id=canonicalRemoteId(sessionId)||sessionId;generation++;for(const [serverId,ctx]of contexts)if(ctx.sessionId===id||ctx.sessionId===sessionId){getPreviewHost()?.destroyPreview(serverId);contexts.delete(serverId);for(const admission of tabAdmissions.keys())if(admission.startsWith(serverId+'\0'))tabAdmissions.delete(admission);}for(const [serverId,entry]of browserServers)if(entry.sessionId===sessionId||entry.sessionId===id)browserServers.delete(serverId);for(const k of pending.keys())if(k.startsWith(id+'\0'))pending.delete(k);for(const k of once.keys())if(k.startsWith(id+'\0'))once.delete(k);}
  function dispose(){if(disposed)return;disposed=true;generation++;for(const serverId of contexts.keys())getPreviewHost()?.destroyPreview(serverId);contexts.clear();tabAdmissions.clear();pending.clear();once.clear();remembered.clear();browserServers.clear();}
  return {startBrowserPreview,ensureRemoteBlankPreview,resolveRemotePaneConsent,recordRemotePaneOriginDecision,admitRemotePaneOriginOnce,
    authorizeRead,readsEnabled,revokeSession,dispose,getActiveServers:()=>[...browserServers.values()].filter(value=>hostTabs(value.previewId).tabs.length>0).map(value=>({...value}))};
}
module.exports={createPreviewAccess,canonicalRemoteId,httpOrigin};
