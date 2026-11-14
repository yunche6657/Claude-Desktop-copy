import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const require=createRequire(import.meta.url);
const {createFixtureHistoryImportHost}=require('../desktop/history-import-fixture-host.cjs');
const {exportFixtureToKernel}=require('../desktop/history-import-kernel-fixture.cjs');
const {createHistoryImportKernelResumeHost}=require('../desktop/history-import-kernel-host.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-resume-host-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const homeDir=path.join(root,'home');
 for(const dir of ['state','stage','journal','target','projects/p','home/projects/-fixture']) await fs.mkdir(path.join(root,dir),{recursive:true});
 await fs.writeFile(path.join(root,'.history-import-fixture'),'synthetic-history-import-v1');
 const source='c63d48ea-53e7-48a7-95bb-b8f3ef2e7ec5';
 await fs.writeFile(path.join(root,'projects/p',`${source}.jsonl`),JSON.stringify({type:'user',cwd:'/fixture',uuid:'u',sessionId:source,message:{role:'user',content:'hello'}})+'\n');
 const identity={accountId:'a',orgId:'o',generation:'1'};
 const host=createFixtureHistoryImportHost({root,identity});
 const [entry]=await host.scan(), imported=await host.importSource(entry.sourceToken);
 assert.equal(imported.status,'registered');
 const storePath=path.join(root,'kernel.json');await exportFixtureToKernel({root,host,storePath});
 const id=`local_${imported.sessionId}`;
 const backend={id:'ccb',start(){},sendMessage(){},cancel(){},getInfo:()=>null,getActiveProcesses:()=>[],onEvent:()=>()=>{},dispose(){}};
 const kernel=createSessionKernel({backend,storePath,emit(){},historyImportResumeHost:host.createResumeHost({homeDir})});
 t.after(()=>kernel.dispose());
 return {root,host,identity,kernel,storePath,id,homeDir,imported};
}

test('registered fixture confirms through the kernel and persists the installed transcript',async t=>{
 const f=await fixture(t);
 assert.equal(await f.kernel.confirmImportedSessionResume(f.id),true);
 const session=JSON.parse(await fs.readFile(f.storePath,'utf8')).sessions[0];
 assert.equal(session.resumeConfirmed,true);
 assert.equal(session.ccbResume.homeDir,f.homeDir);
 assert.equal(session.ccbResume.cliSessionId,f.imported.cliSessionId);
 assert.equal(await fs.readFile(session.ccbResume.transcriptPath,'utf8'),await fs.readFile(path.join(f.root,'target',`${f.imported.cliSessionId}.jsonl`),'utf8'));
});

test('fixture refuses foreign identity, changed content, and an existing target',async t=>{
 for(const mode of ['identity','digest','conflict']) {
  const f=await fixture(t),snapshot=await f.host.inspect(),r=snapshot.registrations[0];
  if(mode==='identity') f.identity.generation='2';
  if(mode==='digest') await fs.appendFile(r.stagedTranscriptPath,'altered');
  if(mode==='conflict') await fs.writeFile(path.join(f.homeDir,'projects','-fixture',`${r.cliSessionId}.jsonl`),'existing');
  assert.equal(await f.kernel.confirmImportedSessionResume(f.id),false,mode);
  assert.notEqual(JSON.parse(await fs.readFile(f.storePath,'utf8')).sessions[0].resumeConfirmed,true);
  if(mode==='conflict') assert.equal(await fs.readFile(path.join(f.homeDir,'projects','-fixture',`${r.cliSessionId}.jsonl`),'utf8'),'existing');
 }
});

test('publication survives failed commit and requires the same registration and target',async t=>{
 for(const mode of ['retry','same-bytes-conflict','target-changed','identity']) {
  const f=await fixture(t),base=f.host.createResumeHost({homeDir:f.homeDir});
  const session=JSON.parse(await fs.readFile(f.storePath,'utf8')).sessions[0];
  const target=path.join(f.homeDir,'projects','-fixture',`${session.cliSessionId}.jsonl`);
  if(mode==='same-bytes-conflict') await fs.copyFile(session.stagedTranscriptPath,target);
  const attempt=()=>base.confirm({sessionId:f.id,session,isCurrent:()=>true,commit:()=>false});
  const first=await attempt();
  assert.equal(first.status,mode==='same-bytes-conflict'?'conflict':'installed-unconfirmed',mode);
  if(mode==='target-changed') {await fs.unlink(target);await fs.writeFile(target,'user change');}
  if(mode==='identity') f.identity.orgId='another';
  let commits=0;
  const second=await base.confirm({sessionId:f.id,session,isCurrent:()=>true,commit:()=>{commits++;return true;}});
  assert.equal(second.status,mode==='retry'?'confirmed':mode==='identity'?'invalid':'conflict',mode);
  assert.equal(commits,mode==='retry'?1:0,mode);
  if(mode==='target-changed') assert.equal(await fs.readFile(target,'utf8'),'user change');
  if(mode==='same-bytes-conflict') assert.equal(await fs.readFile(target,'utf8'),await fs.readFile(session.stagedTranscriptPath,'utf8'));
 }
});

test('a fresh process recovers its own published target after commit failure',async t=>{
 const f=await fixture(t);
 const worker=`const fs=require('node:fs');const h=require(process.argv[1]).createFixtureHistoryImportHost({root:process.argv[2],identity:{accountId:'a',orgId:'o',generation:'1'}}).createResumeHost({homeDir:process.argv[3]});const s=JSON.parse(fs.readFileSync(process.argv[4],'utf8')).sessions[0];h.confirm({sessionId:s.sessionId,session:s,isCurrent:()=>true,commit:()=>process.argv[5]==='true'}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1});`;
 const run=commit=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['-e',worker,require.resolve('../desktop/history-import-fixture-host.cjs'),f.root,f.homeDir,f.storePath,String(commit)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
  child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));
 });
 assert.equal((await run(false)).status,'installed-unconfirmed');
 assert.equal((await run(true)).status,'confirmed');
});

test('fresh processes recover crash-left temp links only after verifying all names',async t=>{
 for(const mode of ['before-target','after-target','unknown-link','foreign-target']) {
  const f=await fixture(t);
  const worker=`const fs=require('node:fs'),path=require('node:path');const p=fs.promises;const link=p.link;const mode=process.argv[5],s=JSON.parse(fs.readFileSync(process.argv[4],'utf8')).sessions[0];if(mode!=='retry')p.link=async(a,b)=>{await link(a,b);if(b.includes('.import-proof-')){if(mode==='after-target')await link(b,path.join(path.dirname(b),s.cliSessionId+'.jsonl'));process.exit(77)}};const h=require(process.argv[1]).createFixtureHistoryImportHost({root:process.argv[2],identity:{accountId:'a',orgId:'o',generation:'1'}}).createResumeHost({homeDir:process.argv[3]});h.confirm({sessionId:s.sessionId,session:s,isCurrent:()=>true,commit:()=>true}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1});`;
  const run=phase=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',worker,require.resolve('../desktop/history-import-fixture-host.cjs'),f.root,f.homeDir,f.storePath,phase],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('exit',code=>resolve({code,out,err}));});
  const crashed=await run(mode);assert.equal(crashed.code,77,crashed.err);
  assert.equal((await f.host.store.recoverLock({withExclusiveAccess:fn=>fn(),isAbandoned:()=>true})).status,'unlocked');
  const session=JSON.parse(await fs.readFile(f.storePath,'utf8')).sessions[0],dir=path.join(f.homeDir,'projects','-fixture');
  const files=await fs.readdir(dir),receipt=path.join(dir,files.find(x=>x.startsWith('.import-proof-'))),temp=path.join(dir,files.find(x=>x.startsWith('.import-install-'))),target=path.join(dir,`${session.cliSessionId}.jsonl`);
  assert.equal((await fs.stat(receipt)).ino,(await fs.stat(temp)).ino);
  if(mode==='unknown-link') await fs.link(receipt,path.join(f.root,'other-link'));
  if(mode==='foreign-target') await fs.writeFile(target,'user data');
  const retry=await run('retry');assert.equal(retry.code,0,retry.err);const result=JSON.parse(retry.out);
  assert.equal(result.status,['unknown-link','foreign-target'].includes(mode)?'conflict':'confirmed',mode);
  if(mode==='unknown-link') {await assert.rejects(fs.stat(target),{code:'ENOENT'});assert.ok(await fs.stat(path.join(f.root,'other-link')));}
  if(mode==='foreign-target') assert.equal(await fs.readFile(target,'utf8'),'user data');
 }
});

test('adapter refuses asynchronous lease validity and mismatched registration',async()=>{
 const session={cliSessionId:'cli',cwd:'cwd',stagedTranscriptPath:'stage',importedFrom:'terminalCli'};
 let reads=0;
 const host=createHistoryImportKernelResumeHost({runExclusive:fn=>fn({isCurrent:async()=>true,readRegistration:()=>{reads++;}})});
 await host.confirm({sessionId:'local_a',session,isCurrent:()=>true,commit:()=>{throw Error('unexpected');}});
 assert.equal(reads,0);
 const mismatch=createHistoryImportKernelResumeHost({runExclusive:fn=>fn({isCurrent:()=>true,readRegistration:()=>({...session,sessionId:'local_b',stagingPath:'stage'})})});
 const result=await mismatch.confirm({sessionId:'local_a',session,isCurrent:()=>true,commit:()=>{throw Error('unexpected');}});
 assert.equal(result.status,'invalid');
});

test('rejected asynchronous validity checks are handled and never authorize confirmation',async()=>{
 const session={cliSessionId:'cli',cwd:'cwd',stagedTranscriptPath:'stage',importedFrom:'terminalCli'};
 for(const source of ['lease','kernel','thenable']) {
  let reads=0,commits=0;
  const reject=()=>source==='thenable'?{then(_resolve,reject){reject(Error('rejected thenable'));}}:Promise.reject(Error('rejected validity'));
  const host=createHistoryImportKernelResumeHost({runExclusive:fn=>fn({isCurrent:source==='kernel'?()=>true:reject,readRegistration:()=>{reads++;}})});
  const result=await host.confirm({sessionId:'local_a',session,isCurrent:source==='kernel'?reject:()=>true,commit:()=>{commits++;return true;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(result.status,'invalid',source);
  assert.equal(reads,0,source);
  assert.equal(commits,0,source);
 }
});
