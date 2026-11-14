import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createFixtureHistoryImportHost}=require('../desktop/history-import-fixture-host.cjs');
const {exportFixtureToKernel}=require('../desktop/history-import-kernel-fixture.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');

test('synthetic terminal import opens in the real session kernel',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-kernel-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 for(const dir of ['state','stage','journal','target','projects/p']) await fs.mkdir(path.join(root,dir),{recursive:true});
 await fs.writeFile(path.join(root,'.history-import-fixture'),'synthetic-history-import-v1');
 const source='c63d48ea-53e7-48a7-95bb-b8f3ef2e7ec5';
 const entries=[
  {type:'user',cwd:'/fixture',uuid:'u',sessionId:source,message:{role:'user',content:'fixture message'}},
  {type:'assistant',uuid:'omitted',parentUuid:'u',message:{role:'assistant',content:'no cwd'}},
  {type:'user',cwd:'/fixture',uuid:'tool',parentUuid:'omitted',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-id',content:'fixture result'}]}},
  {type:'assistant',cwd:'/fixture',uuid:'a',parentUuid:'tool',message:{role:'assistant',content:'fixture answer'}}
 ];
 await fs.writeFile(path.join(root,'projects/p',`${source}.jsonl`),entries.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const host=createFixtureHistoryImportHost({root,identity:{accountId:'a',orgId:'o',generation:'1'}});
 const offered=await host.scan(); assert.equal(offered.length,1);
 const result=await host.importSource(offered[0].sourceToken); assert.equal(result.status,'registered');
 const storePath=path.join(root,'kernel.json');
 assert.equal((await exportFixtureToKernel({root,host,storePath})).count,1);
 await assert.rejects(exportFixtureToKernel({root,host,storePath}),{code:'EEXIST'});
 const backend={id:'fixture',start(){},sendMessage(){},cancel(){},onEvent(){return ()=>{}},dispose(){}};
 const kernel=createSessionKernel({backend,storePath,emit:()=>{}});
 t.after(()=>kernel.dispose());
 const id=`local_${result.sessionId}`,session=kernel.getSession(id);
 assert.equal(session.cliSessionId,result.cliSessionId);
 assert.equal(session.importedFrom,'terminalCli');
 const transcript=kernel.getTranscript(id);
 assert.deepEqual(transcript.map(row=>row.uuid),['u','tool','a']);
 assert.deepEqual(transcript.map(row=>row.parentUuid),[null,'u','tool']);
 assert.equal(transcript[0].message.content,'fixture message');
 assert.equal(transcript[1].message.content[0].content,'fixture result');
 assert.equal(kernel.confirmImportedSessionResume(id),false);
 assert.equal((await host.scan()).length,0);
 await host.store.runExclusive(lease=>lease.commit({sourceSessionId:'foreign-source',sessionId:'foreign-session',identityKey:JSON.stringify(['b','other','1'])},()=>true));
 assert.equal((await exportFixtureToKernel({root,host,storePath:path.join(root,'second-kernel.json')})).count,1);
 const snapshot=await host.inspect();
 const registration=snapshot.sessions.sessions[0];
 const fakeHost={inspect:async()=>({...snapshot,sessions:{sessions:[{...registration,identityKey:'foreign'}]}})};
 await assert.rejects(exportFixtureToKernel({root,host:fakeHost,storePath:path.join(root,'foreign.json')}),/identity|registration/);
 await fs.appendFile(registration.stagedTranscriptPath,'tampered\n');
 await assert.rejects(exportFixtureToKernel({root,host,storePath:path.join(root,'tampered.json')}),/digest mismatch/);
 await assert.rejects(fs.stat(path.join(root,'tampered.json')),{code:'ENOENT'});
});

test('native staging skips messages without cwd and leaves filtered parent references',async()=>{
 const original=await fs.readFile(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
 const part=(start,end)=>{const a=original.indexOf(start),b=original.indexOf(end,a);assert.ok(a>=0&&b>a);return original.slice(a,b);};
 const input=[{type:'user',cwd:'/work',uuid:'u',sessionId:'source',message:{role:'user',content:'start'}},
  {type:'assistant',uuid:'omitted',parentUuid:'u',message:{role:'assistant',content:'missing cwd'}},
  {type:'user',cwd:'/work',uuid:'tool',parentUuid:'omitted',message:{role:'user',content:[{type:'tool_result',tool_use_id:'id',content:'result'}]}}];
 const written=[];
 const context={Py:async()=>'/source',m9:async()=>({close:async()=>{}}),n:path.posix,f:{randomUUID:()=> 'id'},
  ri:()=>({on(){},write(s){written.push(s);return true;},end(callback){callback();},destroy(){}}),
  o:{default:{promises:{unlink:async()=>{}}}},b$a:16777216,
  BQa:async function*(){yield* input.map(row=>JSON.stringify(row));},_9:async()=>'/work',g9:()=>()=>{},h:{once:async()=>{}}};
 const code=part('function h9(','function _$a(')+part('function y$a(','var b$a=')+
  part('function l$a(','function u$a(')+part('async function C$a(','function w$a(')+';globalThis.nativeImport=C$a';
 vm.runInNewContext(code,context);
 const result=await context.nativeImport('/source','/root','/staging',()=>true);
 assert.equal(result.safeCwd,'/work');
 const rows=written.map(line=>JSON.parse(line));
 assert.deepEqual(rows.map(row=>row.uuid),['u','tool']);
 assert.equal(rows[1].parentUuid,'omitted');
 assert.equal(rows[0].sessionId,undefined);
});
