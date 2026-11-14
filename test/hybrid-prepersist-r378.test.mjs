import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createHybridOidcLogin}=require('../desktop/hybrid-oidc-login.cjs');
const {createHybridOidcSession}=require('../desktop/hybrid-oidc-session.cjs');
const {createHybridOidcStore}=require('../desktop/hybrid-oidc-store.cjs');
import os from 'node:os';
import path from 'node:path';
test('validated grant invalidates old cache before locked slot retains new credential',async()=>{
 const events=[];let retained;
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:'test-new',refresh_token:'test-refresh'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const login=createHybridOidcLogin({fetch,openBrowser:async url=>{const u=new URL(url),cb=new URL(u.searchParams.get('redirect_uri'));cb.searchParams.set('state',u.searchParams.get('state'));cb.searchParams.set('code','fixture');await fetch(cb);},
  assertTokenBoundToHybridOrg:async()=>{events.push('bound');return {accountUuid:'fixture'};},beforePersist:()=>events.push('invalidated'),
  slotStore:{write:(_key,cred)=>{events.push('write');retained=cred;const e=Error('locked');e.code='HYBRID_ENCRYPTION_UNAVAILABLE';e.credentialRetained=true;throw e;}}});
 try{await assert.rejects(login.signIn({storeKey:'fixture',authorizationUrl:origin+'/authorize',tokenUrl:origin+'/token',apiOrigin:origin,clientId:'fixture',scopes:'test'}),/locked/);assert.deepEqual(events,['bound','invalidated','write']);assert.equal(retained.accessToken,'test-new');}
 finally{login.invalidate();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('locked new login replaces an already cached bearer without persisting plaintext',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prepersist-'));let available=true;
 const encryption={isEncryptionAvailable:()=>available,encryptString:s=>Buffer.from(s.split('').reverse().join('')),decryptString:b=>b.toString().split('').reverse().join('')};
 const store=createHybridOidcStore({userData:dir,safeStorage:encryption});const oidc={storeKey:'fixture',clientId:'fixture',scopes:'test'};
 store.write('fixture',{accessToken:'old-fixture'});
 const session=createHybridOidcSession({storage:store,fetch});assert.equal((await session.getBearer(oidc)).bearer,'old-fixture');
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:'new-fixture'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const login=createHybridOidcLogin({fetch,slotStore:store,beforePersist:()=>session.invalidate(),assertTokenBoundToHybridOrg:async()=>({}),openBrowser:async url=>{const u=new URL(url),cb=new URL(u.searchParams.get('redirect_uri'));cb.searchParams.set('state',u.searchParams.get('state'));cb.searchParams.set('code','test');await fetch(cb);}});
 try{available=false;await assert.rejects(login.signIn({...oidc,authorizationUrl:origin+'/authorize',tokenUrl:origin+'/token',apiOrigin:origin}),{code:'HYBRID_ENCRYPTION_UNAVAILABLE'});assert.equal((await session.getBearer(oidc)).bearer,'new-fixture');assert.ok(!fs.readFileSync(path.join(dir,'custom3p-bootstrap-oidc.json'),'utf8').includes('new-fixture'));}
 finally{session.invalidate();login.invalidate();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('main wires the before-persist invalidation to the real login instance',()=>{
 const source=fs.readFileSync(new URL('../desktop/main.cjs',import.meta.url),'utf8');
 assert.match(source,/beforePersist:\s*hybridIdentity\.beforePersist/);
 assert.match(source,/invalidateBearer:.*hybridOidcSession\.invalidate\(\).*hybridAuthResults\.clear\(\).*hybridAuthRequests\.clear\(\)/);
});
