import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createHybridOidcStore}=require('../desktop/hybrid-oidc-store.cjs');
const {deriveHybridOidc,createHybridOidcSession}=require('../desktop/hybrid-oidc-session.cjs');
const {createHybridControlFetch}=require('../desktop/hybrid-control-fetch.cjs');
const {createGrowthBookModeBackend}=require('../desktop/growthbook-mode-backend.cjs');
const {createMainGrowthBookRuntime}=require('../desktop/main-growthbook-runtime.cjs');
const key=crypto.randomBytes(32);
// Test-only cipher dependency; actual main uses Electron safeStorage.
const cipher={isEncryptionAvailable:()=>true,encryptString:s=>{
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);
  const bytes=Buffer.concat([c.update(s,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);
},decryptString:b=>{const d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}};
test('encrypted named store round trips across instances, preserves other slots and locked credentials',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hybrid-slots-')),file=path.join(dir,'custom3p-bootstrap-oidc.json');
 try{
  const store=createHybridOidcStore({userData:dir,safeStorage:cipher});const cred={accessToken:'synthetic-private-slot',refreshToken:'synthetic-refresh'};
  store.write('hybrid:https://one.invalid:unknown',cred);store.write('hybrid:https://two.invalid:unknown',{accessToken:'second'});
  assert.ok(!fs.readFileSync(file,'utf8').includes(cred.accessToken));
  const fresh=createHybridOidcStore({userData:dir,safeStorage:cipher});assert.deepEqual(fresh.read('hybrid:https://one.invalid:unknown'),cred);
  const locked=createHybridOidcStore({userData:dir,safeStorage:{...cipher,isEncryptionAvailable:()=>false}});
  const before=fs.readFileSync(file);assert.equal(locked.read('hybrid:https://one.invalid:unknown'),undefined);
  assert.throws(()=>locked.write('new',cred),/encryption unavailable/);assert.deepEqual(locked.read('new'),cred);assert.deepEqual(fs.readFileSync(file),before);
  const bad=JSON.parse(before);bad.custom3pBootstrapOidc.corrupt='broken';fs.writeFileSync(file,JSON.stringify(bad));
  assert.equal(fresh.read('corrupt'),undefined);assert.equal(JSON.parse(fs.readFileSync(file)).custom3pBootstrapOidc.corrupt,'broken');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('existing encrypted slot refresh reaches isolated feature source and actual provider reader',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hybrid-chain-'));let refreshes=0,featureCalls=0;const requests=[];
 const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;res.setHeader('content-type','application/json');
  if(req.url==='/token'){refreshes++;assert.equal(JSON.parse(body).refresh_token,'fixture-refresh');res.end(JSON.stringify({access_token:'fixture-new',refresh_token:'fixture-rotated',expires_in:3600}));}
  else{featureCalls++;requests.push(req.headers.authorization);res.end(JSON.stringify({user:{id:'fixture'},features:{'144321860':{value:'authorized-fixture',on:true}}}));}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,bootstrap=origin+'/bootstrap';
 const store=createHybridOidcStore({userData:dir,safeStorage:cipher}),oidc=deriveHybridOidc(bootstrap,{apiHost:origin,clientId:'fixture-client'});
 store.write(oidc.storeKey,{accessToken:'fixture-old',refreshToken:'fixture-refresh',expiresAt:0,tokenUrl:origin+'/token',clientId:'fixture-client'});
 const session=createHybridOidcSession({storage:createHybridOidcStore({userData:dir,safeStorage:cipher}),fetch});
 const control=createHybridControlFetch({electronSession:{fromPartition:name=>{assert.equal(name,'custom3p-probe');return{fetch};}},oidcFor:()=>oidc,resolveBearer:o=>session.getBearer(o)});
 const backend=createGrowthBookModeBackend({getConfig:()=>({mode:'3p',bootstrap:{url:bootstrap,enabled:true}}),packaged:false,developmentOrigin:origin,hybridAuthedFetch:control,appVersion:'fixture-version',totalMemoryBytes:8e9});
 const runtime=createMainGrowthBookRuntime({getContext:backend.getContext,userData:dir});
 try{await runtime.init();assert.equal(runtime.getFeatureValue('144321860',null),'authorized-fixture');assert.equal(refreshes,1);assert.equal(featureCalls,1);assert.deepEqual(requests,['Bearer fixture-new']);store.clearMemory();assert.equal(store.read(oidc.storeKey).refreshToken,'fixture-rotated');}
 finally{runtime.dispose();session.invalidate();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
