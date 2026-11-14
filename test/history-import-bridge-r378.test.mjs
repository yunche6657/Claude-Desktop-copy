import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createHistoryImportBridge}=require('../desktop/history-import-bridge.cjs');
const {createFixtureHistoryImportHost}=require('../desktop/history-import-fixture-host.cjs');

test('default closed and authority revocation fail closed',async()=>{
 const closed=createHistoryImportBridge();
 assert.deepEqual(await closed.enumerateSessionSources(),[]);
 assert.deepEqual(await closed.scanSessionSource('x'),{sourceId:'x',shape:'unknown',sessions:[]});
 assert.deepEqual(await closed.importSessionSources(0,['x']),{imported:0,skipped:0});
 let valid=true,calls=0;
 const b=createHistoryImportBridge({rootPath:'/fixture',label:'fixture',getAuthority:()=>({key:'a',isCurrent:()=>valid}),host:{supportsAtomicAuthorityCommit:true,scan:async()=>[{sourceToken:'secret',sessionId:'s',lastActivityAt:1}],importSource:async()=>{calls++;return {status:'registered'}}}});
 const [source]=await b.enumerateSessionSources();
 assert.equal((await b.scanSessionSource(source.id)).sessions[0].sourceToken,undefined);
 valid=false;
 assert.deepEqual(await b.importSessionSources(0,[source.id]),{imported:0,skipped:0});
 assert.equal(calls,0);
});

test('existing fixture host without atomic authority contract remains disabled',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-bridge-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 for(const dir of ['state','stage','journal','target','projects/p']) await fs.mkdir(path.join(root,dir),{recursive:true});
 await fs.writeFile(path.join(root,'.history-import-fixture'),'synthetic-history-import-v1');
 const id='c63d48ea-53e7-48a7-95bb-b8f3ef2e7ec5';
 await fs.writeFile(path.join(root,'projects/p',id+'.jsonl'),JSON.stringify({type:'user',cwd:'/fixture',sessionId:id,message:{content:'synthetic'}})+'\n');
 const host=createFixtureHistoryImportHost({root,identity:{accountId:'fixture',orgId:'fixture',generation:'1'}});
 const b=createHistoryImportBridge({host,getAuthority:()=>({key:'fixture',isCurrent:()=>true}),rootPath:path.join(root,'projects'),label:'fixture'});
 assert.deepEqual(await b.enumerateSessionSources(),[]);
 assert.equal((await host.inspect()).registrations.length,0);
});

test('finite timestamps honor cutoff and use the host commit guard',async()=>{
 const calls=[];
 const entries=[{sourceToken:'equal',lastActivityAt:5},{sourceToken:'later',lastActivityAt:6},{sourceToken:'old',lastActivityAt:4},{sourceToken:'missing'},{sourceToken:'nan',lastActivityAt:NaN},{sourceToken:'infinity',lastActivityAt:Infinity}];
 const host={supportsAtomicAuthorityCommit:true,scan:async()=>entries,importSource:async(token,{isCurrent})=>{
  if (!await isCurrent()) return {status:'refused'};
  calls.push(token);return {status:'registered'};
 }};
 const b=createHistoryImportBridge({host,rootPath:'/fixture',label:'fixture',getAuthority:()=>({key:'a',isCurrent:()=>true})});
 const [source]=await b.enumerateSessionSources();
 assert.deepEqual(await b.importSessionSources(5,[source.id]),{imported:2,skipped:0});
 assert.deepEqual(calls,['equal','later']);
});

test('captured authority revocation is enforced by the host at commit',async()=>{
 let valid=true,commitCount=0,started,release;
 const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const host={supportsAtomicAuthorityCommit:true,scan:async()=>[{sourceToken:'t',lastActivityAt:1}],importSource:async(token,{isCurrent})=>{
  started();await gate;
  if(!await isCurrent()) return {status:'refused'};
  commitCount++;return {status:'registered'};
 }};
 const b=createHistoryImportBridge({host,rootPath:'/fixture',label:'fixture',getAuthority:()=>({key:'a',isCurrent:()=>valid})});
 const [source]=await b.enumerateSessionSources();
 const pending=b.importSessionSources(0,[source.id]);await entered;valid=false;release();
 assert.deepEqual(await pending,{imported:0,skipped:1});assert.equal(commitCount,0);
});

test('a replacement authority with the same key cannot revive a revoked snapshot',async()=>{
 let initial=true,calls=0;
 const old={key:'a',isCurrent:()=>initial};
 let authority=old;
 const host={supportsAtomicAuthorityCommit:true,scan:async()=>[{sourceToken:'t',lastActivityAt:1}],importSource:async()=>{calls++;return {status:'registered'}}};
 const b=createHistoryImportBridge({host,rootPath:'/fixture',label:'fixture',getAuthority:()=>authority});
 const [source]=await b.enumerateSessionSources();
 initial=false;authority={key:'a',isCurrent:()=>true};
 assert.deepEqual(await b.importSessionSources(0,[source.id]),{imported:0,skipped:0});
 assert.equal(calls,0);
});

test('revocation after a reported commit is an uncertain outcome, not success',async()=>{
 let valid=true;
 const host={supportsAtomicAuthorityCommit:true,scan:async()=>[{sourceToken:'t',lastActivityAt:1}],importSource:async(token,{isCurrent})=>{
  assert.equal(await isCurrent(),true);valid=false;return {status:'registered'};
 }};
 const b=createHistoryImportBridge({host,rootPath:'/fixture',label:'fixture',getAuthority:()=>({key:'a',isCurrent:()=>valid})});
 const [source]=await b.enumerateSessionSources();
 await assert.rejects(b.importSessionSources(0,[source.id]),/outcome requires reconciliation/);
});

test('a new scan after commit but before its result requires reconciliation',async()=>{
 let committed,release;
 const entered=new Promise(r=>committed=r),gate=new Promise(r=>release=r);
 const host={supportsAtomicAuthorityCommit:true,scan:async()=>[{sourceToken:'t',lastActivityAt:1}],importSource:async(token,{isCurrent})=>{
  assert.equal(await isCurrent(),true);
  committed();await gate;return {status:'registered'};
 }};
 const b=createHistoryImportBridge({host,rootPath:'/fixture',label:'fixture',getAuthority:()=>({key:'a',isCurrent:()=>true})});
 const [source]=await b.enumerateSessionSources();
 const pending=b.importSessionSources(0,[source.id]);await entered;
 await b.enumerateSessionSources();release();
 await assert.rejects(pending,/outcome requires reconciliation/);
});
