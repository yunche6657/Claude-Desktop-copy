import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const source=fs.readFileSync(new URL('../desktop/main.cjs',import.meta.url),'utf8');
const {createHybridOidcSession}=createRequire(import.meta.url)('../desktop/hybrid-oidc-session.cjs');
const start=source.indexOf('let hybridAuthSourceIdentity;'),end=source.indexOf('let windowState;',start);
const callbackStart=source.indexOf('onMainFeatureSourceChanged: () => {'),callbackEnd=source.indexOf('\n    getBootstrapAuthStatus:',callbackStart);
const bearerStart=source.indexOf('resolveBearer: async oidc => {'),bearerEnd=source.indexOf('\n    },',bearerStart);
assert.ok(start>=0&&end>start&&callbackStart>=0&&callbackEnd>callbackStart&&bearerStart>=0&&bearerEnd>bearerStart);
const callbackCode=source.slice(callbackStart+'onMainFeatureSourceChanged: '.length,callbackEnd).trim().replace(/,$/,'');
const bearerCode=source.slice(bearerStart+'resolveBearer: '.length,bearerEnd)+'\n}';

function harness(session){
 let config={mode:'3p',bootstrap:{url:'https://fixture.invalid/one',enabled:true}},aborts=0,logins=0,refreshes=0,gateInvalidations=0;
 const results=new Map(),requests=new Map();
 const context=vm.createContext({bridge:{getMainGrowthBookSourceConfig:()=>config},hybridOidcSession:session,hybridAuthResults:results,hybridAuthRequests:requests,
  bootstrapAuthAbort:{abort:()=>aborts++},hybridLogin:{invalidate:()=>logins++},cliMcpGateSource:{invalidate:()=>gateInvalidations++},cowork3pMemoryIdentity:{observe:()=>{}},resolveCoworkMemoryIdentity:{observe:()=>{}},mainFeatures:{refreshSource:()=>{refreshes++;return Promise.resolve();}}});
 vm.runInContext(source.slice(start,end),context);
 const sync=vm.runInContext('syncHybridAuthSource',context),change=vm.runInContext(`(${callbackCode})`,context),resolve=vm.runInContext(`(${bearerCode})`,context);
 return {context,sync,change,resolve,results,requests,setConfig:value=>{config=value},setPending:()=>{context.bootstrapAuthAbort={abort:()=>aborts++}},counts:()=>({aborts,logins,refreshes}),gateCount:()=>gateInvalidations};
}

test('only authentication source changes invalidate the session and pending login',()=>{
 let invalidations=0;const h=harness({invalidate:()=>invalidations++});
 h.sync();h.results.set('slot','ready');h.requests.set('slot',Symbol());
 h.setConfig({mode:'3p',bootstrap:{url:'https://fixture.invalid/one'},builtinBrowserEnabled:true});h.change();
 assert.equal(invalidations,0);assert.equal(h.results.get('slot'),'ready');assert.equal(h.requests.size,1);assert.deepEqual(h.counts(),{aborts:0,logins:0,refreshes:1});assert.equal(h.gateCount(),1);
 for(const config of [
  {mode:'3p',bootstrap:{url:'https://fixture.invalid/two'}},
  {mode:'3p',bootstrap:{url:'https://fixture.invalid/two',enabled:false}},
  {mode:'1p',bootstrap:{url:'https://fixture.invalid/two',enabled:false}},
 ]){h.setPending();h.results.set('slot','ready');h.requests.set('slot',Symbol());h.setConfig(config);h.change();assert.equal(h.results.size,0);assert.equal(h.requests.size,0);}
 assert.equal(invalidations,3);assert.deepEqual(h.counts(),{aborts:3,logins:3,refreshes:4});h.change();assert.equal(invalidations,3);
});

test('source synchronization is harmless before initialization and after confirmed quit',()=>{
 let invalidations=0;const h=harness({invalidate:()=>invalidations++});const bridge=h.context.bridge,session=h.context.hybridOidcSession;
 h.context.bridge=undefined;h.sync();h.context.bridge=bridge;h.context.hybridOidcSession=null;h.sync();h.context.hybridOidcSession=session;h.sync();
 assert.equal(invalidations,0);vm.runInContext('hybridAuthStopped = true',h.context);
 h.setConfig({mode:'1p'});h.change();assert.equal(invalidations,0);assert.equal(h.counts().aborts,0);
 assert.match(source,/const launchFeatureConfig = bridge\.getMainGrowthBookSourceConfig\(\);\s*syncHybridAuthSource\(\);/);
 assert.match(source,/if \(event\?\.defaultPrevented\) return;\s*hybridAuthStopped = true;/);
});

test('old refresh cannot write or publish status after switching source',async()=>{
 let release,started;const startedPromise=new Promise(r=>started=r),response=new Promise(r=>release=r);
 let grant={accessToken:'old',refreshToken:'old-refresh',expiresAt:0,clientId:'fixture',tokenUrl:'https://fixture.invalid/token'},writes=0;
 const storage={read:()=>grant,write:(_key,value,{isCurrent})=>{if(isCurrent()){writes++;grant=value;}}};
 const session=createHybridOidcSession({storage,now:()=>100,fetch:()=>{started();return response}}),h=harness(session);h.sync();
 const old=h.resolve({storeKey:'slot'});await startedPromise;
 h.setConfig({mode:'3p',bootstrap:{url:'https://fixture.invalid/two',enabled:true}});h.change();
 grant={accessToken:'new',refreshToken:'new-refresh',expiresAt:1000000,clientId:'fixture',tokenUrl:'https://fixture.invalid/token'};
 const fresh=h.resolve({storeKey:'slot'});release(new Response('{"access_token":"late"}'));
 const oldResult=await old,freshResult=await fresh;
 assert.equal(oldResult.ok,false);assert.equal(freshResult.ok,true);assert.equal(freshResult.bearer,'new');
 assert.equal(writes,0);assert.equal(grant.accessToken,'new');assert.equal(h.results.get('slot'),'ready');assert.equal(h.requests.size,0);
});
