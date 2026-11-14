import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const {createCcbKernel}=createRequire(import.meta.url)('../desktop/ccb-kernel.cjs');

for (const mention of [false,true]) for (const decision of ['unwired','deny','allow']) {
test(`real CCB outside-workspace staged file: ${decision}, mention=${mention}`, {skip:process.env.CCD_REAL_UPLOAD_PROOF!=='1',timeout:60000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccb-upload-proof-'));
 for(const dir of ['work','home','appdata','localappdata','userdata/pending-uploads'])fs.mkdirSync(path.join(root,dir),{recursive:true});
 const file=path.join(root,'userdata','pending-uploads',`${crypto.randomUUID()}-fixture.txt`), marker='ISOLATED_ATTACHMENT_CONTENT_378';
 fs.writeFileSync(file,marker);
 const report={realAccount:false,realModel:false,decision,mention,requests:0,readObserved:false,markerByRequest:[],markerBlocks:[],toolResults:[],approvals:[],events:[],result:null};
 const server=http.createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());report.requests++;
  report.readObserved ||= JSON.stringify(body.messages).includes(marker);report.markerByRequest.push(JSON.stringify(body.messages).includes(marker));report.markerBlocks.push((body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>JSON.stringify(b.content??b.text??'').includes(marker)).map(b=>({role:m.role,type:b.type})):[]));report.toolResults.push(...(body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='tool_result').map(b=>({is_error:b.is_error,marker:JSON.stringify(b.content).includes(marker)})):[]));
  res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  emit('message_start',{message:{id:`msg_${crypto.randomUUID()}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
  if(report.requests===1){emit('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_upload',name:'Read',input:{}}});emit('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({file_path:file})}});emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:5}})}
  else {emit('content_block_start',{index:0,content_block:{type:'text',text:''}});emit('content_block_delta',{index:0,delta:{type:'text_delta',text:'fixture complete'}});emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}})}
  emit('message_stop',{});res.end();
 }catch(e){report.serverError=String(e);res.writeHead(400).end()}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const core='D:\\CodexArtifacts\\claude-code-desktop\\R378-NOTIFICATION-RELAY-HISTORY-ASAR\\resources\\agent-core';
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),TEMP:process.env.TEMP,TMP:process.env.TMP,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'synthetic-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
 const backend=createCcbKernel({bunPath:path.join(core,'bun/bun.exe'),entryPath:path.join(core,'claude-code/dist/cli-bun.js'),kernelRoot:path.join(core,'claude-code'),cwd:path.join(root,'work'),homeDir:path.join(root,'home'),env,scratchDir:process.env.TEMP,model:'claude-sonnet-4-5',turnTimeoutMs:25000,disposeTimeoutMs:3000,permissionMode:'default',permissionPromptTool:'stdio'});
 backend.onEvent(e=>{if(['tool_permission_request','tool_permission_resolved'].includes(e.type))report.events.push({type:e.type,decision:e.decision,toolName:e.request?.toolName});});
 try{
  const opts={};if(decision!=='unwired')opts.requestApproval=async request=>{report.approvals.push({toolName:request.toolName,selectedPath:request.input?.file_path===file});return decision;};
  const result=await backend.sendMessage('upload-fixture',mention ? `Read the staged attachment @"${file}".` : 'Read the fixture selected by the test.',opts);report.result={stopReason:result.stopReason};
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));t.diagnostic(`report: ${path.join(root,'report.json')}`);
  assert.ok(report.requests>=2,JSON.stringify(report));
  assert.equal(report.markerByRequest[0],mention,JSON.stringify(report));
  if(decision==='allow'){assert.ok(report.toolResults.some(r=>!r.is_error && (mention || r.marker)),JSON.stringify(report));assert.ok(report.approvals.some(a=>a.toolName==='Read'&&a.selectedPath),JSON.stringify(report));}
  else {assert.equal(report.toolResults.some(r=>r.marker),false,JSON.stringify(report));assert.ok(decision==='deny'?report.approvals.length>0:report.events.some(e=>e.type==='tool_permission_request'),JSON.stringify(report));}
 } finally {await backend.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
}
