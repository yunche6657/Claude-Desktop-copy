import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createIsolatedHistoryImportHost}=createRequire(import.meta.url)('../desktop/history-import-host.cjs');
const source='c63d48ea-53e7-48a7-95bb-b8f3ef2e7ec5';
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-host-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const projectsRoot=path.join(root,'projects'),stagingDir=path.join(root,'stage'),journalDirectory=path.join(root,'journal'),projectDir=path.join(root,'target');
 await fs.mkdir(path.join(projectsRoot,'p'),{recursive:true}); for(const d of [stagingDir,journalDirectory,projectDir]) await fs.mkdir(d);
 await fs.writeFile(path.join(projectsRoot,'p',`${source}.jsonl`),JSON.stringify({type:'user',cwd:'/fixture',sessionId:source,message:{content:'hello'}})+'\n');
 let version=1, records=[], localSessions=[], fail=false, foreign=false, locked=false;
 const options={projectsRoot,stagingDir,journalDirectory,projectDir,getIdentity:()=>({accountId:'fixture',orgId:'org',generation:'1'}),resolveTrustedCwd:()=>'/fixture',
 runExclusive:async fn=>{assert.equal(locked,false); locked=true;try{return await fn();}finally{locked=false;}},
 readInventory:()=>{const v=version;return {complete:true,coverage:{allAccountsAndOrgs:true,loadedSessions:true,deletingSessions:true,tombstones:true},records:foreign?[{stem:'other',currentTenant:false,record:{priorCliSessionIds:[source]}}]:records.map(r=>({stem:r.sessionId,currentTenant:true,record:r})),tombstones:[],liveClaims:[],version:v,isCurrent:()=>v===version};},
 readManifestSnapshot:()=>{const v=version;return {complete:true,state:'ok',content:JSON.stringify({localSessions}),version:v,isCurrent:()=>v===version};},
 commitRegistration:async r=>{assert.equal(locked,true);assert.equal(await r.isCurrent(),true); records.push({...r});localSessions.push(r.sourceSessionId);version++;if(fail)throw Error('lost response');return 'registered';}};
 return {options,api:createIsolatedHistoryImportHost(options),setForeign:()=>{foreign=true;version++;},setFail:()=>fail=true,getRecords:()=>records,getManifest:()=>localSessions};
}
test('isolated host installs staged transcript and commits account source with registration',async t=>{
 const f=await fixture(t), [item]=await f.api.scan(), result=await f.api.importSource(item.sourceToken);
 assert.equal(result.status,'registered'); assert.deepEqual(f.getManifest(),[source]); const [record]=f.getRecords(); assert.equal(record.importedFrom,'terminal-cli');
 assert.equal(record.cliSessionId,result.cliSessionId); assert.match(await fs.readFile(record.stagedTranscriptPath,'utf8'),/hello/); assert.deepEqual(await createIsolatedHistoryImportHost(f.options).scan(),[]);
});
test('foreign prior ID blocks registration after scan',async t=>{const f=await fixture(t),[item]=await f.api.scan();f.setForeign();assert.equal((await f.api.importSource(item.sourceToken)).status,'already-owned');assert.equal(f.getRecords().length,0);});
test('lost commit response retains reservation and positive proof recovers it',async t=>{
 const f=await fixture(t),[item]=await f.api.scan();f.setFail();await assert.rejects(f.api.importSource(item.sourceToken),/lost response/);
 const fresh=createIsolatedHistoryImportHost(f.options);assert.deepEqual(await fresh.scan(),[]); const [r]=f.getRecords();
 const result=await fresh.recover(source,()=>({complete:true,sourceSessionId:source,sessionId:r.sessionId,cliSessionId:r.cliSessionId,identityKey:r.identityKey,isCurrent:()=>true}));assert.equal(result.status,'recovered'); assert.equal(f.getRecords().length,1);
});
