import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {createPreviewAccess,canonicalRemoteId,httpOrigin}=require('../desktop/preview-access.cjs');
function environment(){const local='local_11111111-2222-4333-8444-555555555555',remote='session_alpha',url='http://127.0.0.1:45001/';const records=new Map(),remoteSessions=new Map([[remote,{verified:true,linkedThread:false,halted:false,cwd:os.tmpdir(),identityEpoch:1}]]);const gestures=new Set(),origins=[];let enabled=true,standing=false,clock=100,classificationHook=null;const policy={available:true,externalBrowsingDisabled:false,epoch:1};const categories=new Map();
 const host={async createPreview(id,target,cwd,sessionId){if(!records.has(id))records.set(id,{id,target,cwd,sessionId,epoch:1,frames:[],tabs:[{tabId:'seed',url:target}],activeTabId:'seed'});return{previewId:id,tabId:'seed'};},getPreviewTabs(id){const r=records.get(id);return r?{tabs:r.tabs.map(tab=>({...tab})),activeTabId:r.activeTabId}:{tabs:[],activeTabId:'seed'};},destroyPreview(id){return records.delete(id);}};
 const current=(id,tabId)=>{const r=records.get(id),tab=r?.tabs.find(tab=>tab.tabId===tabId);if(!r||!tab||!/^https?:/.test(tab.url))return null;return{serverId:id,tabId,cwd:r.cwd,sessionId:r.sessionId,url:tab.url,origin:new URL(tab.url).origin,epoch:r.epoch,frames:structuredClone(r.frames)};};
 const service=createPreviewAccess({getPreviewHost:()=>host,getSession:id=>id===local?{cwd:os.tmpdir()}:null,getRemoteSession:id=>remoteSessions.get(id),featureEnabled:()=>enabled,getPolicy:async()=>({...policy}),classifyOrigin:async target=>{await classificationHook?.(target);return{kind:'ok',category:categories.get(new URL(target).origin)||'category0',privateNetworkOnly:categories.get(new URL(target).origin)==='category3'};},readAllowedOrigins:()=>[...origins],writeAllowedOrigins:async next=>{origins.splice(0,origins.length,...next);return true;},consumeUserGesture:sender=>gestures.delete(sender),getStandingReadPermission:async()=>standing,getCurrentStamp:current,isWorkspaceTrusted:()=>true,now:()=>clock});
 function navigate(id,target,frameUrls=[target]){const r=records.get(id);r.tabs.find(tab=>tab.tabId===r.activeTabId).url=target;r.epoch++;r.frames=frameUrls.map((value,index)=>({processId:12,routingId:index+1,url:value}));}
 return{local,remote,url,host,service,records,remoteSessions,gestures,origins,policy,categories,current,navigate,setEnabled:value=>enabled=value,setStanding:value=>standing=value,setClock:value=>clock=value,setClassifyHook:hook=>classificationHook=hook};}

test('native remote canonicalization does not turn local session IDs or artifact IDs into remote permission identities',()=>{
 assert.equal(canonicalRemoteId('cse_ABC_123'),'session_ABC_123');assert.equal(canonicalRemoteId('local_11111111-2222-4333-8444-555555555555'),null);assert.equal(canonicalRemoteId('session_'),null);assert.equal(canonicalRemoteId('preview-remote-artifact_fixture'),null);assert.equal(httpOrigin('https://www.example.com./path'),'https://example.com');assert.equal(httpOrigin('http://user:password@localhost'),null);assert.equal(httpOrigin('file:///tmp/x'),null);
});

test('local browser and verified remote contexts create real host contexts with distinct prefixes',async()=>{
 const e=environment();try{const local=await e.service.startBrowserPreview(os.tmpdir(),e.local);assert.equal(local,'preview-'+e.local);assert.equal(e.host.getPreviewTabs(local).tabs[0].url,'about:blank');assert.equal(e.service.getActiveServers()[0].previewId,local);assert.equal(await e.service.ensureRemoteBlankPreview('cse_alpha'), 'preview-remote-session_alpha');assert.equal(await e.service.ensureRemoteBlankPreview('session_unknown'),null);assert.equal(await e.service.ensureRemoteBlankPreview(e.local),null);assert.equal(await e.service.startBrowserPreview('relative',e.local),null);
 }finally{e.service.dispose();}
});

test('normal pending-site consent requires a main-side gesture and allows the subsequent action once',async()=>{
 const e=environment();try{const id=await e.service.ensureRemoteBlankPreview(e.remote);const query={sessionId:e.remote,toolName:'navigate',url:e.url};const decision=await e.service.resolveRemotePaneConsent(query);assert.deepEqual(decision,{kind:'card',origin:new URL(e.url).origin,tabId:'seed',perAction:false,reason:'site'});assert.equal(await e.service.admitRemotePaneOriginOnce(e.remote,e.url,{untrusted:true}),false);
 const sender={nativeInput:true};e.gestures.add(sender);assert.equal(await e.service.admitRemotePaneOriginOnce(e.remote,e.url,sender),true);assert.deepEqual(await e.service.resolveRemotePaneConsent(query),{kind:'allow'});assert.equal((await e.service.resolveRemotePaneConsent(query)).kind,'card');e.navigate(id,e.url);assert.equal(await e.service.authorizeRead(e.current(id,'seed')),true);
 }finally{e.service.dispose();}
});

test('remembered grants use the injected settings source and do not survive its explicit removal',async()=>{
 const e=environment();try{await e.service.ensureRemoteBlankPreview(e.remote);const query={sessionId:e.remote,toolName:'navigate',url:e.url};await e.service.resolveRemotePaneConsent(query);const sender={};e.gestures.add(sender);assert.equal(await e.service.recordRemotePaneOriginDecision(e.remote,e.url,false,sender),false);assert.equal(await e.service.recordRemotePaneOriginDecision(e.remote,e.url,true,sender),true);assert.deepEqual(e.origins,[new URL(e.url).origin]);assert.equal((await e.service.resolveRemotePaneConsent(query)).kind,'allow');e.origins.length=0;assert.equal((await e.service.resolveRemotePaneConsent(query)).kind,'card');assert.equal(await e.service.recordRemotePaneOriginDecision(e.remote,e.url,true,sender),false);
 }finally{e.service.dispose();}
});

test('private/high-risk approval is per-action and cannot silently become an always read permission',async()=>{
 const e=environment();try{const id=await e.service.ensureRemoteBlankPreview(e.remote);e.categories.set(new URL(e.url).origin,'category3');const query={sessionId:e.remote,toolName:'navigate',url:e.url};assert.equal((await e.service.resolveRemotePaneConsent(query)).perAction,true);const sender={};e.gestures.add(sender);assert.equal(await e.service.recordRemotePaneOriginDecision(e.remote,e.url,true,sender),false);e.navigate(id,e.url);assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);e.setStanding(true);assert.equal(await e.service.authorizeRead(e.current(id,'seed')),true);e.navigate(id,e.url,[e.url,'http://127.0.0.1:45002/frame']);assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);
 }finally{e.service.dispose();}
});

test('organization policy, banking/blocked subframes and unknown policy deny without consuming approval',async()=>{
 const e=environment();try{const id=await e.service.ensureRemoteBlankPreview(e.remote);e.navigate(id,e.url);e.policy.externalBrowsingDisabled=true;assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);assert.equal((await e.service.resolveRemotePaneConsent({sessionId:e.remote,toolName:'navigate',url:e.url})).kind,'deny');e.policy.externalBrowsingDisabled=false;e.policy.available=false;assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);e.policy.available=true;e.categories.set('http://127.0.0.1:45002','category1');e.navigate(id,e.url,[e.url,'http://127.0.0.1:45002/frame']);assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);
 }finally{e.service.dispose();}
});

test('actual navigation, frame epoch, feature and identity changes during asynchronous policy checks withhold reads',async()=>{
 const e=environment();try{const id=await e.service.ensureRemoteBlankPreview(e.remote);e.navigate(id,e.url);let first=true;e.setClassifyHook(()=>{if(first){first=false;e.navigate(id,e.url+'changed');}});assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);e.setClassifyHook(null);assert.equal(await e.service.authorizeRead(e.current(id,'seed')),true);e.setClassifyHook(()=>{e.policy.epoch++});assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);e.setClassifyHook(null);e.remoteSessions.get(e.remote).identityEpoch=2;assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);e.remoteSessions.get(e.remote).identityEpoch=1;e.setEnabled(false);assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);
 }finally{e.service.dispose();}
});

test('pending card navigation changes and linked/halted remote sessions cannot mint user grants',async()=>{
 const e=environment();try{const id=await e.service.ensureRemoteBlankPreview(e.remote);e.navigate(id,e.url);await e.service.resolveRemotePaneConsent({sessionId:e.remote,toolName:'navigate',url:e.url+'next'});e.navigate(id,e.url+'moved');const sender={};e.gestures.add(sender);assert.equal(await e.service.admitRemotePaneOriginOnce(e.remote,e.url,sender),false);e.remoteSessions.get(e.remote).linkedThread=true;assert.equal(await e.service.ensureRemoteBlankPreview(e.remote),null);assert.equal(await e.service.authorizeRead(e.current(id,'seed')),false);e.remoteSessions.get(e.remote).linkedThread=false;e.remoteSessions.get(e.remote).halted=true;assert.equal(await e.service.ensureRemoteBlankPreview(e.remote),null);
 }finally{e.service.dispose();}
});

test('one-shot approvals expire after native 120 seconds and ordinary dev-server contexts never acquire remote reads',async()=>{
 const e=environment();try{const remote=await e.service.ensureRemoteBlankPreview(e.remote);const query={sessionId:e.remote,toolName:'navigate',url:e.url};await e.service.resolveRemotePaneConsent(query);const sender={};e.gestures.add(sender);assert.equal(await e.service.admitRemotePaneOriginOnce(e.remote,e.url,sender),true);e.setClock(120101);assert.equal((await e.service.resolveRemotePaneConsent(query)).kind,'card');const local=await e.service.startBrowserPreview(os.tmpdir(),e.local);e.navigate(local,e.url);assert.equal(await e.service.authorizeRead(e.current(local,'seed')),false);e.service.revokeSession(e.remote);assert.equal(e.records.has(remote),false);assert.equal(await e.service.authorizeRead({serverId:remote}),false);
 }finally{e.service.dispose();}
});


test('loaded public pages do not manufacture mutation consent and authentic one-time decisions bind the current tab',async()=>{
 const e=environment();try{const id=await e.service.ensureRemoteBlankPreview(e.remote);e.navigate(id,e.url);const query={sessionId:e.remote,toolName:'form_input'};assert.equal((await e.service.resolveRemotePaneConsent(query)).kind,'card');const sender={};e.gestures.add(sender);assert.equal(await e.service.admitRemotePaneOriginOnce(e.remote,e.url,sender),true);assert.equal((await e.service.resolveRemotePaneConsent(query)).kind,'allow');assert.equal((await e.service.resolveRemotePaneConsent(query)).kind,'allow');
 }finally{e.service.dispose();}
});

test('pending approvals cannot be upgraded when policy classification changes before the user decision',async()=>{
 const e=environment();try{await e.service.ensureRemoteBlankPreview(e.remote);const sender={};e.gestures.add(sender);assert.equal(await e.service.recordRemotePaneOriginDecision(e.remote,e.url,true,sender),false);await e.service.resolveRemotePaneConsent({sessionId:e.remote,toolName:'navigate',url:e.url});e.categories.set(new URL(e.url).origin,'category3');e.gestures.add(sender);assert.equal(await e.service.recordRemotePaneOriginDecision(e.remote,e.url,true,sender),false);assert.deepEqual(e.origins,[]);
 }finally{e.service.dispose();}
});

test('actual host tab summaries need not expose URL when getPreviewUrl supplies the selected document',async()=>{
 const e=environment();try{const id=await e.service.ensureRemoteBlankPreview(e.remote);e.navigate(id,e.url);const getTabs=e.host.getPreviewTabs;e.host.getPreviewTabs=serverId=>{const state=getTabs(serverId);return{...state,tabs:state.tabs.map(tab=>({tabId:tab.tabId,origin:httpOrigin(tab.url),loading:false}))};};e.host.getPreviewUrl=serverId=>e.records.get(serverId)?.tabs[0]?.url??null;assert.equal(await e.service.authorizeRead(e.current(id,'seed')),true);const card=await e.service.resolveRemotePaneConsent({sessionId:e.remote,toolName:'form_input',neverSilent:true});assert.equal(card.kind,'card');assert.equal(card.origin,new URL(e.url).origin);
 }finally{e.service.dispose();}
});
