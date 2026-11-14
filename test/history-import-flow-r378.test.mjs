import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createTerminalImportFlow}=createRequire(import.meta.url)('../desktop/history-import-flow.cjs');
const id='c63d48ea-53e7-48a7-95bb-b8f3ef2e7ec5';
async function fixture(t,registerStaged){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-flow-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const projectsRoot=path.join(root,'projects'),folder=path.join(projectsRoot,'proj'),stagingDir=path.join(root,'stage'),journalDirectory=path.join(root,'journal');
 await fs.mkdir(folder,{recursive:true}); await fs.mkdir(stagingDir); await fs.mkdir(journalDirectory);
 await fs.writeFile(path.join(folder,`${id}.jsonl`),JSON.stringify({type:'user',cwd:'/work',sessionId:'source-secret',message:{content:'hello'}})+'\n');
 const identity={accountId:'account',orgId:'org',generation:'epoch'}, owned=new Set();
 const options={projectsRoot,stagingDir,journalDirectory,getIdentity:()=>identity,getOwnedCliSessionIds:()=>owned,resolveTrustedCwd:cwd=>cwd==='/work'?cwd:null,registerStaged};
 return {options,owned,stagingDir,flow:createTerminalImportFlow(options)};
}
test('scan, staged registration and subsequent restart use the source reservation together',async t=>{
 let attempts=0; const f=await fixture(t,async request=>{attempts++; assert.equal(request.sourceSessionId,id); assert.equal(await request.isCurrent(),true); const text=await fs.readFile(request.staged.stagingPath,'utf8'); assert.equal(text.includes('source-secret'),false); return 'registered';});
 const [entry]=await f.flow.scan(); const result=await f.flow.importSource(entry.sourceToken); assert.equal(result.status,'registered'); assert.equal(attempts,1);
 assert.deepEqual(await createTerminalImportFlow(f.options).scan(),[]);
});
test('uncertain registration remains reserved and is not offered by later scan',async t=>{
 const f=await fixture(t,async()=>{throw Error('lost response');}); const [entry]=await f.flow.scan();
 await assert.rejects(f.flow.importSource(entry.sourceToken),/lost response/);
 assert.deepEqual(await createTerminalImportFlow(f.options).scan(),[]);
});
test('an unoffered token cannot trigger a registration',async t=>{
 let calls=0; const f=await fixture(t,async()=>{calls++;return 'registered';});
 assert.equal((await f.flow.importSource('invented')).status,'not-offered'); assert.equal(calls,0);
});

test('account change at registration leaves pending reservation and source stays hidden',async t=>{
 let f; f=await fixture(t,async request=>{f.options.getIdentity().orgId='other'; assert.equal(await request.isCurrent(),false); return 'aborted';});
 const [entry]=await f.flow.scan(); assert.equal((await f.flow.importSource(entry.sourceToken)).status,'pending');
 f.options.getIdentity().orgId='org'; assert.deepEqual(await createTerminalImportFlow(f.options).scan(),[]);
});

test('flow recovers an isolated durable registration after its reply is lost',async t=>{
 let f, calls=0;
 f=await fixture(t,async request=>{
  calls++; assert.equal(await request.isCurrent(),true);
  await fs.writeFile(path.join(f.options.journalDirectory,'fixture-registered.json'),JSON.stringify({sourceSessionId:request.sourceSessionId,sessionId:request.sessionId,cliSessionId:request.cliSessionId,identityKey:request.staged.identityKey}));
  throw Error('reply lost');
 });
 const [entry]=await f.flow.scan(); await assert.rejects(f.flow.importSource(entry.sourceToken),/reply lost/);
 const restarted=createTerminalImportFlow(f.options);
 assert.deepEqual(await restarted.scan(),[]);
 const recovered=await restarted.recover(id,async()=>({...JSON.parse(await fs.readFile(path.join(f.options.journalDirectory,'fixture-registered.json'),'utf8')),complete:true,isCurrent:()=>true}));
 assert.equal(recovered.status,'recovered'); assert.equal(calls,1); assert.deepEqual(await restarted.scan(),[]);
});

test('flow passes ownership snapshot versions to registration-time checks',async t=>{
 let version=1; const f=await fixture(t,async request=>{version=2; assert.equal(await request.isCurrent(),false); return 'aborted';});
 f.options.getOwnershipSnapshot=()=>{const v=version;return {complete:true,version:v,cliSessionIds:new Set(),isCurrent:()=>version===v};};
 const flow=createTerminalImportFlow(f.options); const [entry]=await flow.scan();
 assert.equal((await flow.importSource(entry.sourceToken)).status,'pending');
});

test('native source manifest snapshot suppresses already imported source before scan and commit',async t=>{
 let calls=0; const f=await fixture(t,async()=>{calls++;return 'registered';}); let entries=new Set([id]); let version=1;
 f.options.getSourceManifestSnapshot=()=>{let v=version;return {complete:true,version:v,sourceSessionIds:new Set(entries),isCurrent:()=>v===version};};
 const flow=createTerminalImportFlow(f.options); assert.deepEqual(await flow.scan(),[]); entries.clear(); version++;
 const [entry]=await flow.scan(); entries.add(id); version++;
 assert.equal((await flow.importSource(entry.sourceToken)).status,'already-imported'); assert.equal(calls,0);
});

test('manifest identity switch prevents returning a stale scan',async t=>{
 const f=await fixture(t,async()=> 'registered');
 f.options.getSourceManifestSnapshot=()=>{f.options.getIdentity().orgId='different';return {complete:true,version:1,sourceSessionIds:new Set(),isCurrent:()=>true};};
 const flow=createTerminalImportFlow(f.options); await assert.rejects(flow.scan(),/identity changed/);
});

test('native-format manifest file data can drive the isolated flow source filter',async t=>{
 const {createNativeSourceManifestProvider}=createRequire(import.meta.url)('../desktop/history-import-manifest.cjs');
 const f=await fixture(t,async()=> 'registered'); const file=path.join(f.options.journalDirectory,'fixture-import-manifest.json');
 await fs.writeFile(file,JSON.stringify({localSessions:[id],runs:[]})); let version=1;
 f.options.getSourceManifestSnapshot=createNativeSourceManifestProvider({readSnapshot:async()=>{const captured=version;return {complete:true,state:'ok',content:await fs.readFile(file,'utf8'),version:captured,isCurrent:()=>captured===version};}});
 assert.deepEqual(await createTerminalImportFlow(f.options).scan(),[]);
 await fs.writeFile(file,JSON.stringify({localSessions:[],runs:[]})); version++;
 assert.equal((await createTerminalImportFlow(f.options).scan()).length,1);
 await fs.writeFile(file,'broken'); version++;
 await assert.rejects(createTerminalImportFlow(f.options).scan(),/manifest invalid/);
});
