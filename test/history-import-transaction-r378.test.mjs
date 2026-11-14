import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const {createImportTransaction}=createRequire(import.meta.url)('../desktop/history-import-transaction.cjs');
const id='c63d48ea-53e7-48a7-95bb-b8f3ef2e7ec5';
async function fixture(t,register) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'history-journal-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let identity={accountId:'account',orgId:'org',generation:'generation'};
 const owned=new Set(); const options={directory,getIdentity:()=>identity,getOwnedCliSessionIds:()=>owned,register};
 return {directory,owned,options,setIdentity:x=>{identity=x;},api:createImportTransaction(options)};
}
test('reservation persists source and generated IDs before registration and deduplicates on restart',async t=>{
 let f; let calls=0;
 f=await fixture(t,async args=>{calls++; assert.equal(await args.isCurrent(),true); const state=JSON.parse(await fs.readFile(path.join(f.directory,'history-import-reservations.json'),'utf8')); assert.equal(state.entries[id].state,'pending'); assert.equal(state.entries[id].sessionId,args.sessionId); return 'registered';});
 const first=await f.api.run({sourceSessionId:id,sourceToken:'token'}); assert.equal(first.status,'registered');
 const second=await createImportTransaction(f.options).run({sourceSessionId:id.toUpperCase(),sourceToken:'another'});
 assert.equal(second.status,'already-imported'); assert.equal(calls,1);
 const state=JSON.parse(await fs.readFile(path.join(f.directory,'history-import-reservations.json'),'utf8')); assert.equal(state.entries[id].state,'committed');
});

test('concurrent independent instances do not register the same source twice',async t=>{
 let release,entered; const enteredPromise=new Promise(resolve=>{entered=resolve;}); const held=new Promise(resolve=>{release=resolve;}); let calls=0;
 const f=await fixture(t,async()=>{calls++;entered();await held;return 'registered';});
 const first=f.api.run({sourceSessionId:id,sourceToken:'token'}); await enteredPromise;
 assert.equal((await createImportTransaction(f.options).run({sourceSessionId:id,sourceToken:'token'})).status,'busy');
 release(); assert.equal((await first).status,'registered'); assert.equal(calls,1);
});

test('lost registration result stays pending after restart and ownership prevents registration',async t=>{
 let calls=0; const f=await fixture(t,async()=>{calls++;throw Error('response lost');});
 await assert.rejects(f.api.run({sourceSessionId:id,sourceToken:'token'}),/response lost/);
 assert.equal((await createImportTransaction(f.options).run({sourceSessionId:id,sourceToken:'token'})).status,'pending'); assert.equal(calls,1);
 const other='9bec91ee-5ae8-4f99-b7c2-a9769303c9db'; f.owned.add(other);
 assert.equal((await f.api.run({sourceSessionId:other,sourceToken:'token'})).status,'already-owned'); assert.equal(calls,1);
});

test('registration host can observe identity and ownership changes before its commit',async t=>{
 let f; f=await fixture(t,async args=>{f.setIdentity({accountId:'account',orgId:'other',generation:'next'}); assert.equal(await args.isCurrent(),false); return 'aborted';});
 assert.equal((await f.api.run({sourceSessionId:id,sourceToken:'token'})).status,'pending');
});

test('unreadable journal and abandoned lock fail closed',async t=>{
 let calls=0; const f=await fixture(t,async()=>{calls++;return 'registered';});
 await fs.writeFile(path.join(f.directory,'history-import-reservations.json'),'{broken');
 await assert.rejects(f.api.run({sourceSessionId:id,sourceToken:'token'}),SyntaxError);
 await fs.writeFile(path.join(f.directory,'history-import-reservations.lock'),'abandoned');
 assert.equal((await f.api.run({sourceSessionId:id,sourceToken:'token'})).status,'busy'); assert.equal(calls,0);
});

test('ownership changes observed by callback prevent registration commit',async t=>{
 let f; f=await fixture(t,async args=>{f.owned.add(id); assert.equal(await args.isCurrent(),false); return 'aborted';});
 assert.equal((await f.api.run({sourceSessionId:id,sourceToken:'token'})).status,'pending');
});

test('positive host receipt recovers a lost response without re-registering',async t=>{
 let receipt, calls=0; const f=await fixture(t,async args=>{calls++;receipt=args;throw Error('response lost after commit');});
 await assert.rejects(f.api.run({sourceSessionId:id,sourceToken:'token'}),/response lost/);
 const reopened=createImportTransaction(f.options);
 const result=await reopened.recover(id,async request=>({...request,complete:true,isCurrent:()=>true}));
 assert.equal(result.status,'recovered'); assert.equal(result.sessionId,receipt.sessionId);
 assert.equal((await reopened.run({sourceSessionId:id,sourceToken:'token'})).status,'already-imported'); assert.equal(calls,1);
});

test('recovery requires current manifest evidence when an account manifest is configured',async t=>{
 let version=1, ids=new Set();
 const f=await fixture(t,async()=>{throw Error('lost response');});
 f.options.getSourceManifestSnapshot=()=>{const v=version;return {complete:true,version:v,sourceSessionIds:new Set(ids),isCurrent:()=>v===version};};
 const api=createImportTransaction(f.options);
 await assert.rejects(api.run({sourceSessionId:id,sourceToken:'token'}),/lost response/);
 const proof=request=>({...request,complete:true,isCurrent:()=>true});
 assert.equal((await api.recover(id,proof)).status,'pending');
 ids.add(id); version++;
 assert.equal((await api.recover(id,proof)).status,'recovered');
});

test('recovery retains pending if manifest evidence becomes stale before journal publication',async t=>{
 let committed=false, checks=0;
 const f=await fixture(t,async()=>{committed=true;throw Error('lost response');});
 f.options.getSourceManifestSnapshot=()=>({complete:true,version:1,sourceSessionIds:new Set(committed?[id]:[]),
  isCurrent:()=>!committed || ++checks===1});
 const api=createImportTransaction(f.options);
 await assert.rejects(api.run({sourceSessionId:id,sourceToken:'token'}),/lost response/);
 const result=await api.recover(id,request=>({...request,complete:true,isCurrent:()=>true}));
 assert.equal(result.status,'pending');
 assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,'history-import-reservations.json'),'utf8')).entries[id].state,'pending');
});

test('incomplete, mismatched, stale or changed-tenancy recovery evidence stays pending',async t=>{
 const f=await fixture(t,async()=>{throw Error('uncertain');});
 await assert.rejects(f.api.run({sourceSessionId:id,sourceToken:'token'}),/uncertain/);
 const proof=(request,patch={})=>({...request,complete:true,isCurrent:()=>true,...patch});
 for (const patch of [{complete:false},{sessionId:'not-the-session'},{sourceSessionId:'another'},{isCurrent:()=>false}]) {
  assert.equal((await f.api.recover(id,request=>proof(request,patch))).status,'pending');
 }
 f.setIdentity({accountId:'account',orgId:'other',generation:'generation'});
 assert.equal((await f.api.recover(id,request=>proof(request))).status,'pending');
 f.setIdentity({accountId:'account',orgId:'org',generation:'generation'});
 assert.equal((await f.api.run({sourceSessionId:id,sourceToken:'token'})).status,'pending');
});

test('recovery cannot race a still-running registration',async t=>{
 let entered,release; const started=new Promise(r=>{entered=r;}), hold=new Promise(r=>{release=r;});
 const f=await fixture(t,async()=>{entered();await hold;return 'registered';});
 const running=f.api.run({sourceSessionId:id,sourceToken:'token'}); await started;
 assert.equal((await createImportTransaction(f.options).recover(id,async request=>({...request,complete:true,isCurrent:()=>true}))).status,'busy');
 release(); assert.equal((await running).status,'registered');
});

test('recovery rechecks proof after writing its temporary journal and retains pending on invalidation',async t=>{
 const f=await fixture(t,async()=>{throw Error('lost response');});
 await assert.rejects(f.api.run({sourceSessionId:id,sourceToken:'token'}),/lost response/);
 let checks=0;
 const result=await f.api.recover(id,request=>({...request,complete:true,isCurrent:()=>++checks===1}));
 assert.equal(result.status,'pending');
 assert.equal(checks,2);
 const journal=JSON.parse(await fs.readFile(path.join(f.directory,'history-import-reservations.json'),'utf8'));
 assert.equal(journal.entries[id].state,'pending');
 assert.equal((await fs.readdir(f.directory)).filter(name=>name.endsWith('.tmp')).length,0);
});

test('versioned ownership invalidates a registration even when source remains unowned',async t=>{
 let version=1, oldCurrent=true, checks=0;
 const f=await fixture(t,async request=>{version=2; oldCurrent=false; assert.equal(await request.isCurrent(),false); checks++;return 'aborted';});
 f.options.getOwnershipSnapshot=()=>{const captured=version;return {complete:true,version:captured,cliSessionIds:new Set(),isCurrent:()=>captured===version && (captured!==1 || oldCurrent)};};
 const api=createImportTransaction(f.options);
 assert.equal((await api.run({sourceSessionId:id,sourceToken:'token'})).status,'pending'); assert.equal(checks,1);
});

test('incomplete ownership coverage refuses before reserving or registering',async t=>{
 let calls=0; const f=await fixture(t,async()=>{calls++;return 'registered';});
 f.options.getOwnershipSnapshot=()=>({complete:false,version:1,cliSessionIds:new Set(),isCurrent:()=>true});
 await assert.rejects(createImportTransaction(f.options).run({sourceSessionId:id,sourceToken:'token'}),/versioned ownership snapshot unavailable/);
 assert.equal(calls,0);
 await assert.rejects(fs.stat(path.join(f.directory,'history-import-reservations.json')),error=>error.code==='ENOENT');
});

test('manifest version change during registration causes isCurrent refusal',async t=>{
 let version=1;const f=await fixture(t,async request=>{version++;assert.equal(await request.isCurrent(),false);return 'aborted';});
 f.options.getSourceManifestSnapshot=()=>{const v=version;return {complete:true,version:v,sourceSessionIds:new Set(),isCurrent:()=>version===v};};
 assert.equal((await createImportTransaction(f.options).run({sourceSessionId:id,sourceToken:'token'})).status,'pending');
});

test('process crash retains pending reservation until exclusive lock and registration recovery',async t=>{
 const f=await fixture(t,async()=>{throw Error('must not register twice');});
 const modulePath=path.resolve('desktop/history-import-transaction.cjs');
 const script=`const {createImportTransaction}=require(process.argv[1]); const fs=require('node:fs'); const path=require('node:path');
 const api=createImportTransaction({directory:process.argv[2],getIdentity:()=>({accountId:'account',orgId:'org',generation:'generation'}),getOwnedCliSessionIds:()=>new Set(),register:args=>{fs.writeFileSync(path.join(process.argv[2],'fixture-receipt.json'),JSON.stringify({sourceSessionId:args.sourceSessionId,sessionId:args.sessionId,cliSessionId:args.cliSessionId,identityKey:JSON.stringify(['account','org','generation'])}));process.exit(17);}});
 api.run({sourceSessionId:process.argv[3],sourceToken:'fixture'}).catch(()=>process.exit(18));`;
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',script,modulePath,f.directory,id],{windowsHide:true,stdio:'ignore'});child.on('error',reject);child.on('exit',resolve);});
 assert.equal(code,17);
 assert.equal((await f.api.run({sourceSessionId:id,sourceToken:'fixture'})).status,'busy');
 const exclusive=async fn=>fn(); // Fixture owns its isolated directory and the child has exited.
 assert.equal((await f.api.recoverAbandonedLock({withExclusiveAccess:exclusive,isAbandoned:()=>false})).status,'busy');
 assert.equal((await f.api.recoverAbandonedLock({withExclusiveAccess:exclusive,isAbandoned:()=>true})).status,'unlocked');
 assert.equal((await f.api.run({sourceSessionId:id,sourceToken:'fixture'})).status,'pending');
 assert.equal((await f.api.recover(id,async()=>({...JSON.parse(await fs.readFile(path.join(f.directory,'fixture-receipt.json'),'utf8')),complete:true,isCurrent:()=>true}))).status,'recovered');
 assert.equal((await f.api.run({sourceSessionId:id,sourceToken:'fixture'})).status,'already-imported');
});

test('abandoned lock recovery refuses a lock changed while proof is obtained',async t=>{
 const f=await fixture(t,async()=>{throw Error('not called');});
 const lock=path.join(f.directory,'history-import-reservations.lock');
 await fs.writeFile(lock,'original');
 const result=await f.api.recoverAbandonedLock({withExclusiveAccess:async fn=>fn(),isAbandoned:async()=>{await fs.writeFile(lock,'different content');return true;}});
 assert.equal(result.status,'changed');
 assert.equal(await fs.readFile(lock,'utf8'),'different content');
});
