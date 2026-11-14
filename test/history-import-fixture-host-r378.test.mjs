import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createFixtureHistoryImportHost}=require('../desktop/history-import-fixture-host.cjs');
const worker=path.resolve('tools/history-import-fixture-worker.cjs');
const source='c63d48ea-53e7-48a7-95bb-b8f3ef2e7ec5';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-full-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 for(const p of ['state','stage','journal','target','projects/p']) await fs.mkdir(path.join(root,p),{recursive:true});
 await fs.writeFile(path.join(root,'.history-import-fixture'),'synthetic-history-import-v1');
 await fs.writeFile(path.join(root,'projects/p',`${source}.jsonl`),JSON.stringify({type:'user',cwd:'/fixture',sessionId:source,message:{content:'hello'}})+'\n');
 return root;
}
function run(root,mode){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[worker,root,mode],{windowsHide:true,env:process.env});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));});}
test('independent processes register and reopen session and account projections',async t=>{
 const root=await fixture(t),a=await run(root,'import');assert.equal(a.code,0,a.err);assert.equal(JSON.parse(a.out).status,'registered');
 const b=await run(root,'inspect');assert.equal(b.code,0,b.err);const state=JSON.parse(b.out);assert.deepEqual(state.manifest.localSessions,[source]);assert.equal(state.sessions.version,2);assert.equal(state.sessions.sessions.length,1);assert.equal(state.sessions.sessions[0].importedFrom,'terminal-cli');
 assert.equal(JSON.parse((await run(root,'import')).out).status,'none');
});
test('foreign ownership and stale identity prevent import',async t=>{
 const root=await fixture(t);const host=createFixtureHistoryImportHost({root,identity:{accountId:'other',orgId:'other',generation:'1'}});
 await host.store.runExclusive(l=>l.commit({sourceSessionId:'other-source',sessionId:'other-session',identityKey:JSON.stringify(['other','other','1']),priorCliSessionIds:[source]},()=>true));
 const r=await run(root,'import');assert.equal(r.code,0,r.err);assert.equal(JSON.parse(r.out).status,'none');
 const other=await fixture(t),s=await run(other,'stale');assert.equal(s.code,0,s.err);assert.notEqual(JSON.parse(s.out).status,'registered');assert.equal(JSON.parse((await run(other,'inspect')).out).registrations.length,0);
});
test('crash after durable commit retains record and requires explicit lock recovery',async t=>{
 const root=await fixture(t),r=await run(root,'crash');assert.equal(r.code,42,r.err);
 const host=createFixtureHistoryImportHost({root,identity:{accountId:'account-a',orgId:'org-a',generation:'1'}});
 assert.equal(JSON.parse((await run(root,'inspect')).out).status,'busy');
 const proof={withExclusiveAccess:fn=>fn(),isAbandoned:()=>true};
 assert.equal((await host.store.recoverLock(proof)).status,'unlocked');
 assert.equal((await host.recoverAbandonedLock(proof)).status,'unlocked');
 const snapshot=await host.inspect(),record=snapshot.registrations[0];assert.deepEqual(snapshot.manifest.localSessions,[source]);
 const recovered=await host.recover(source,()=>({complete:true,sourceSessionId:source,sessionId:record.sessionId,cliSessionId:record.cliSessionId,identityKey:record.identityKey,isCurrent:()=>true}));
 assert.equal(recovered.status,'recovered');assert.equal((await host.inspect()).registrations.length,1);
});
