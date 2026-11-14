import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createCcbKernel}=require('../desktop/ccb-kernel.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {createFixtureHistoryImportHost}=require('../desktop/history-import-fixture-host.cjs');
const {readCliTranscript}=require('../desktop/cli-transcript.cjs');

test('real CCB resumes an installed synthetic transcript with a local model service', {skip:process.env.CCD_REAL_IMPORT_PROOF!=='1',timeout:60000}, async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'real-import-resume-'));
 const report={kind:'isolated-real-ccb-import-resume',realAccount:false,realModel:false,root,checks:{},requests:[]};
 t.diagnostic(`Evidence directory: ${root}`);
 let seedBackend,resumeBackend,seedKernel,resumeKernel;
 const server=http.createServer(async(req,res)=>{
  try {
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const messages=body.messages||[];
   report.requests.push({priorUser:messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('R378_PRIOR_USER')),priorAssistant:messages.some(m=>m.role==='assistant'&&JSON.stringify(m.content).includes('R378_PRIOR_ASSISTANT')),followup:messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('R378_FOLLOWUP'))});
   res.writeHead(200,{'content-type':'text/event-stream'});
   const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
   emit('message_start',{message:{id:`msg_${crypto.randomUUID()}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}});
   emit('content_block_start',{index:0,content_block:{type:'text',text:''}});
   emit('content_block_delta',{index:0,delta:{type:'text_delta',text:report.requests.length===1?'R378_PRIOR_ASSISTANT':'R378_RESUMED_ASSISTANT'}});
   emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:4}});emit('message_stop',{});res.end();
  } catch(error){res.writeHead(400);res.end();report.serverError=String(error);}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try {
  const cwd=path.join(root,'work'),stage=path.join(root,'target'),home=path.join(root,'resume-home'),seedHome=path.join(root,'seed-home');
  for(const dir of [cwd,stage,home,seedHome,path.join(root,'state'),path.join(root,'appdata'),path.join(root,'localappdata')])await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(root,'.history-import-fixture'),'synthetic-history-import-v1');
  const core='D:\\CodexArtifacts\\claude-code-desktop\\R378-NOTIFICATION-RELAY-HISTORY-ASAR\\resources\\agent-core';
  const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'synthetic-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
  const options={bunPath:path.join(core,'bun/bun.exe'),entryPath:path.join(core,'claude-code/dist/cli-bun.js'),kernelRoot:path.join(core,'claude-code'),cwd,env,scratchDir:process.env.TEMP,model:'claude-sonnet-4-5',turnTimeoutMs:25000,disposeTimeoutMs:3000};
  seedBackend=createCcbKernel({...options,homeDir:seedHome});seedKernel=createSessionKernel({backend:seedBackend,emit(){}});
  const initial=seedKernel.start({cwd});
  const first=await seedKernel.sendMessage(initial.sessionId,'R378_PRIOR_USER');assert.equal(first.ok,true,JSON.stringify(first));
  const info=seedBackend.getInfo(initial.sessionId);const cliId=info?.persistence?.cliSessionId;
  assert.ok(cliId,JSON.stringify(info?.persistence));
  const source=path.join(seedHome,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'),`${cliId}.jsonl`);
  let seedBytes='';for(let i=0;i<100;i++){seedBytes=await fs.readFile(source,'utf8').catch(()=>'');if(seedBytes.includes('R378_PRIOR_ASSISTANT'))break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.match(seedBytes,/R378_PRIOR_ASSISTANT/,'seed transcript was not flushed');
  seedKernel.dispose();await seedBackend.dispose();seedKernel=null;seedBackend=null;
  const bytes=await fs.readFile(source),stagingPath=path.join(stage,`${cliId}.jsonl`);await fs.writeFile(stagingPath,bytes);
  const rows=readCliTranscript(source);assert.ok(rows.length>0);
  const projectDir=path.join(home,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'));await fs.mkdir(projectDir,{recursive:true});
  const id='local_imported',store=path.join(root,'kernel.json');
  const session={sessionId:id,cliSessionId:cliId,cwd,workingDir:cwd,importedFrom:'terminalCli',stagedTranscriptPath:stagingPath,isRunning:false,pendingToolPermissions:[]};
  await fs.writeFile(store,JSON.stringify({version:2,sessions:[session],transcripts:{[id]:rows}}));
  resumeBackend=createCcbKernel({...options,homeDir:home});resumeKernel=createSessionKernel({backend:resumeBackend,storePath:store,emit(){}});
  assert.equal(resumeKernel.confirmImportedSessionResume(id),false);await assert.rejects(resumeKernel.sendMessage(id,'R378_FOLLOWUP'),{name:'ImportedResumeGateError'});report.checks.originalGate=true;
  resumeKernel.dispose();await resumeBackend.dispose();resumeKernel=null;resumeBackend=null;
  const fixtureHost=createFixtureHistoryImportHost({root,identity:{accountId:'fixture',orgId:'fixture',generation:'1'}});
  assert.equal(await fixtureHost.store.runExclusive(lease=>lease.commit({sourceSessionId:'fixture-source',sessionId:'imported',
   cliSessionId:cliId,cwd,stagedTranscriptPath:stagingPath,stagedTranscriptSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
   importedFrom:'terminal-cli',identityKey:JSON.stringify(['fixture','fixture','1'])},()=>true)),'registered');
  const historyImportResumeHost=fixtureHost.createResumeHost({homeDir:home});
  const failingHost={confirm:args=>historyImportResumeHost.confirm({...args,commit:()=>false})};
  resumeBackend=createCcbKernel({...options,homeDir:home});resumeKernel=createSessionKernel({backend:resumeBackend,storePath:store,emit(){},historyImportResumeHost:failingHost});
  assert.equal(await resumeKernel.confirmImportedSessionResume(id),false);
  assert.notEqual(JSON.parse(await fs.readFile(store,'utf8')).sessions[0].resumeConfirmed,true);
  report.checks.publishedButUnconfirmed=true;
  resumeKernel.dispose();await resumeBackend.dispose();resumeKernel=null;resumeBackend=null;
  resumeBackend=createCcbKernel({...options,homeDir:home});resumeKernel=createSessionKernel({backend:resumeBackend,storePath:store,emit(){},historyImportResumeHost});
  assert.equal(await resumeKernel.confirmImportedSessionResume(id),true);report.checks.kernelConfirmation=true;
  assert.equal(JSON.parse(await fs.readFile(store,'utf8')).sessions[0].resumeConfirmed,true);
  const followup=await resumeKernel.sendMessage(id,'R378_FOLLOWUP');assert.equal(followup.ok,true,JSON.stringify(followup));
  const actual=report.requests.find(x=>x.followup);assert.deepEqual(actual,{priorUser:true,priorAssistant:true,followup:true});report.checks.priorTranscriptReachedService=true;report.ok=true;
 }catch(error){report.ok=false;report.error=error.stack||String(error);throw error;}
 finally {resumeKernel?.dispose();seedKernel?.dispose();await resumeBackend?.dispose();await seedBackend?.dispose();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));}
});
