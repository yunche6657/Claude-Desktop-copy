import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createCcbKernel}=require('../desktop/ccb-kernel.cjs');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');

test('isolated raw CCB stream-json midturn input observation', {skip:process.env.CCD_REAL_MIDTURN_PROOF!=='1',timeout:45000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccb-midturn-'));
 const dirs=['work','home','appdata','localappdata']; for(const name of dirs)fs.mkdirSync(path.join(root,name),{recursive:true});
 const requests=[],timeline=[];let releaseFirst,firstSeen;const first=new Promise(r=>firstSeen=r);
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{res.writeHead(400).end();return}
  requests.push(body);const count=requests.length;timeline.push({kind:'request',count});
  res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  emit('message_start',{message:{id:`msg_${crypto.randomUUID()}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}});
  emit('content_block_start',{index:0,content_block:{type:'text',text:''}});
  if(count===1){releaseFirst=()=>finish();firstSeen()} else finish();
  function finish(){emit('content_block_delta',{index:0,delta:{type:'text_delta',text:`reply-${count}`}});emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});emit('message_stop',{});res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const core='D:\\CodexArtifacts\\claude-code-desktop\\R378-NOTIFICATION-RELAY-HISTORY-ASAR\\resources\\agent-core';
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),TEMP:process.env.TEMP,TMP:process.env.TMP,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'synthetic-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
 const child=spawn(path.join(core,'bun/bun.exe'),[path.join(core,'claude-code/dist/cli-bun.js'),'--print','--verbose','--input-format','stream-json','--output-format','stream-json','--replay-user-messages','--model','claude-sonnet-4-5'],{cwd:path.join(root,'work'),env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',unparsed='';child.stdout.on('data',b=>{const text=b.toString();stdout+=text;unparsed+=text;let index;while((index=unparsed.indexOf('\n'))>=0){const line=unparsed.slice(0,index);unparsed=unparsed.slice(index+1);try{const f=JSON.parse(line);if(f.type==='user'&&f.isReplay===true)timeline.push({kind:'replay',uuid:f.uuid});if(f.type==='command_lifecycle')timeline.push({kind:'command_lifecycle',uuid:f.command_uuid,state:f.state});}catch{}}});child.stderr.on('data',b=>stderr+=b);
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
 const frame=(text,uuid)=>JSON.stringify({type:'user',uuid,session_id:'fixture',parent_tool_use_id:null,message:{role:'user',content:text}})+'\n';
 let deadline;
 try {
  child.stdin.write(frame('FIRST_SYNTHETIC',ids[0]));
  await Promise.race([first,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error(`first request not seen: ${stderr.slice(-1000)} ${stdout.slice(-1000)}`)),20000)})]);clearTimeout(deadline);
  child.stdin.write(frame('SECOND_SYNTHETIC',ids[1]));
  await new Promise(r=>setTimeout(r,500));
  const before=requests.length;releaseFirst();releaseFirst=null;
  for(let i=0;i<100&&requests.length<2;i++)await new Promise(r=>setTimeout(r,100));
  for(let i=0;i<100&&(stdout.match(/"type":"result"/g)||[]).length<2;i++)await new Promise(r=>setTimeout(r,100));
  child.stdin.write(frame('SECOND_SYNTHETIC',ids[1]));
  for(let i=0;i<30&&requests.length<3;i++)await new Promise(r=>setTimeout(r,100));
  const frames=stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
  const report={realAccount:false,realModel:false,firstHeldRequests:before,totalRequests:requests.length,secondSeen:requests.some(r=>JSON.stringify(r.messages).includes('SECOND_SYNTHETIC')),inputIds:ids,timeline,frames:frames.map(f=>({type:f.type,subtype:f.subtype,uuid:f.uuid,command_uuid:f.command_uuid,state:f.state,isReplay:f.isReplay,parent_tool_use_id:f.parent_tool_use_id,session_id:f.session_id})),exitCode:child.exitCode};
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));t.diagnostic(`report: ${path.join(root,'report.json')}`);
  assert.equal(before,1);assert.equal(report.secondSeen,true);
  assert.deepEqual(report.frames.filter(frame=>frame.type==='user'&&frame.isReplay===true).slice(0,2).map(frame=>frame.uuid),ids);
  assert.ok(report.frames.filter(frame=>frame.type==='result'&&frame.subtype==='success').length>=2);
 } finally {clearTimeout(deadline);if(releaseFirst)releaseFirst();child.stdin.end();if(child.exitCode===null)child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('raw CCB termination with a written queued input remains unconfirmed', {skip:process.env.CCD_REAL_MIDTURN_PROOF!=='1',timeout:30000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccb-midturn-stop-'));
 for(const name of ['work','home','appdata','localappdata'])fs.mkdirSync(path.join(root,name),{recursive:true});
 let firstSeen,firstResponse,requests=0;const first=new Promise(r=>firstSeen=r);
 const server=http.createServer(async(req,res)=>{for await(const _ of req){};requests++;firstResponse=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:'msg-fixture',type:'message',role:'assistant',model:'fixture',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}})+'\n\n');firstSeen()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const core='D:\\CodexArtifacts\\claude-code-desktop\\R378-NOTIFICATION-RELAY-HISTORY-ASAR\\resources\\agent-core';
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),TEMP:process.env.TEMP,TMP:process.env.TMP,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'synthetic-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
 const child=spawn(path.join(core,'bun/bun.exe'),[path.join(core,'claude-code/dist/cli-bun.js'),'--print','--verbose','--input-format','stream-json','--output-format','stream-json','--replay-user-messages','--model','claude-sonnet-4-5'],{cwd:path.join(root,'work'),env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='';child.stdout.on('data',b=>stdout+=b);child.stderr.resume();
 const ids=[crypto.randomUUID(),crypto.randomUUID()],frame=(text,uuid)=>JSON.stringify({type:'user',uuid,session_id:'fixture',parent_tool_use_id:null,message:{role:'user',content:text}})+'\n';let deadline;
 try{
  child.stdin.write(frame('FIRST_STOP_FIXTURE',ids[0]));
  await Promise.race([first,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('first request timed out')),15000)})]);clearTimeout(deadline);
  child.stdin.write(frame('SECOND_STOP_FIXTURE',ids[1]));await new Promise(r=>setTimeout(r,700));
  const frames=stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
  const report={realAccount:false,realModel:false,inputIds:ids,requests,secondReplayed:frames.some(f=>f.type==='user'&&f.isReplay===true&&f.uuid===ids[1]),secondModelRequest:false};
  child.kill();firstResponse.destroy();fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));t.diagnostic(`report: ${path.join(root,'report.json')}`);
  assert.equal(report.requests,1);assert.equal(report.secondReplayed,false);
 }finally{clearTimeout(deadline);if(child.exitCode===null)child.kill();firstResponse?.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('real CCB replay observation is internal and does not duplicate the transcript', {skip:process.env.CCD_REAL_MIDTURN_PROOF!=='1',timeout:30000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccb-observed-session-'));
 for(const name of ['work','home','appdata','localappdata'])fs.mkdirSync(path.join(root,name),{recursive:true});
 const server=http.createServer(async(req,res)=>{for await(const _ of req){};res.writeHead(200,{'content-type':'text/event-stream'});const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);emit('message_start',{message:{id:'msg-fixture',type:'message',role:'assistant',model:'fixture',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}});emit('content_block_start',{index:0,content_block:{type:'text',text:''}});emit('content_block_delta',{index:0,delta:{type:'text_delta',text:'fixture answer'}});emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});emit('message_stop',{});res.end()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const core='D:\\CodexArtifacts\\claude-code-desktop\\R378-NOTIFICATION-RELAY-HISTORY-ASAR\\resources\\agent-core',cwd=path.join(root,'work');
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),TEMP:process.env.TEMP,TMP:process.env.TMP,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'synthetic-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
 const backend=createCcbKernel({bunPath:path.join(core,'bun/bun.exe'),entryPath:path.join(core,'claude-code/dist/cli-bun.js'),kernelRoot:path.join(core,'claude-code'),cwd,homeDir:path.join(root,'home'),scratchDir:process.env.TEMP,env,model:'claude-sonnet-4-5',turnTimeoutMs:20000,disposeTimeoutMs:3000,replayUserMessages:true});
 const backendEvents=[],rendererEvents=[];backend.onEvent(e=>backendEvents.push(e));
 const kernel=createSessionKernel({backend,trackCliInputObservations:true,emit:e=>rendererEvents.push(e)});
 try{
  const id=kernel.start({cwd}).sessionId,uuid=crypto.randomUUID(),result=await kernel.sendMessage(id,'PRIVATE_SYNTHETIC_PROMPT',{messageUuid:uuid});
  assert.equal(result.ok,true);assert.deepEqual(kernel.getCliInputObservation(id),{messageUuid:uuid,status:'cli_observed'});
  assert.equal(kernel.getTranscript(id).filter(row=>row.type==='user').length,1);
  assert.equal(backendEvents.filter(e=>e.type==='user_input_observed'&&e.messageUuid===uuid).length,1);
  assert.equal(backendEvents.some(e=>e.type==='raw'&&e.frame?.type==='user'&&e.frame?.isReplay===true),false);
  assert.equal(rendererEvents.some(e=>e.type==='user_input_observed'),false);
  const report={realAccount:false,realModel:false,observation:'cli_observed',userRows:kernel.getTranscript(id).filter(row=>row.type==='user').length,replayRawForwarded:false,rendererObservationForwarded:false};
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));t.diagnostic(`report: ${path.join(root,'report.json')}`);
 }finally{kernel.dispose();await backend.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('real CCB cancel_async_message withdraws an input still queued behind a held turn', {skip:process.env.CCD_REAL_MIDTURN_PROOF!=='1',timeout:30000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccb-cancel-queued-'));
 for(const name of ['work','home','appdata','localappdata'])fs.mkdirSync(path.join(root,name),{recursive:true});
 let firstSeen,release,requests=0;const first=new Promise(r=>firstSeen=r);
 const server=http.createServer(async(req,res)=>{for await(const _ of req){};requests++;res.writeHead(200,{'content-type':'text/event-stream'});const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);emit('message_start',{message:{id:'msg-fixture',type:'message',role:'assistant',model:'fixture',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}});emit('content_block_start',{index:0,content_block:{type:'text',text:''}});release=()=>{emit('content_block_delta',{index:0,delta:{type:'text_delta',text:'fixture'}});emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});emit('message_stop',{});res.end()};firstSeen()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const core='D:\\CodexArtifacts\\claude-code-desktop\\R378-NOTIFICATION-RELAY-HISTORY-ASAR\\resources\\agent-core';
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),TEMP:process.env.TEMP,TMP:process.env.TMP,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'synthetic-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
 const child=spawn(path.join(core,'bun/bun.exe'),[path.join(core,'claude-code/dist/cli-bun.js'),'--print','--verbose','--input-format','stream-json','--output-format','stream-json','--replay-user-messages','--model','claude-sonnet-4-5'],{cwd:path.join(root,'work'),env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='';child.stdout.on('data',b=>stdout+=b);child.stderr.resume();
 const uuid=crypto.randomUUID(),frame=(text,id)=>JSON.stringify({type:'user',uuid:id,session_id:'fixture',parent_tool_use_id:null,message:{role:'user',content:text}})+'\n';let deadline;
 try{
  child.stdin.write(frame('FIRST_CANCEL_FIXTURE',crypto.randomUUID()));
  await Promise.race([first,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('first request timed out')),15000)})]);clearTimeout(deadline);
  child.stdin.write(frame('SECOND_CANCEL_FIXTURE',uuid));
  child.stdin.write(JSON.stringify({type:'control_request',request_id:'cancel-fixture',request:{subtype:'cancel_async_message',message_uuid:uuid}})+'\n');
  let frames=[];for(let i=0;i<100;i++){frames=stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});if(frames.some(f=>f.type==='control_response'&&f.response?.request_id==='cancel-fixture'))break;await new Promise(r=>setTimeout(r,50));}
  const answer=frames.find(f=>f.type==='control_response'&&f.response?.request_id==='cancel-fixture');
  assert.equal(answer?.response?.response?.cancelled,true);release();release=null;
  for(let i=0;i<100&&!stdout.includes('"type":"result"');i++)await new Promise(r=>setTimeout(r,50));await new Promise(r=>setTimeout(r,500));
  const report={realAccount:false,realModel:false,cancelled:answer.response.response.cancelled,requests,secondReplayed:stdout.includes(uuid)};
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));t.diagnostic(`report: ${path.join(root,'report.json')}`);
  assert.equal(requests,1);
 }finally{clearTimeout(deadline);if(release)release();child.stdin.end();if(child.exitCode===null)child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('raw CCB queued input across a synthetic Read tool cycle', {skip:process.env.CCD_REAL_MIDTURN_PROOF!=='1',timeout:45000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccb-midturn-tool-'));
 for(const name of ['work','home','appdata','localappdata'])fs.mkdirSync(path.join(root,name),{recursive:true});
 const fixture=path.join(root,'work','fixture.txt');fs.writeFileSync(fixture,'SYNTHETIC_READ_CONTENT');
 const requests=[];let releaseFirst,firstSeen;const first=new Promise(r=>firstSeen=r);
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{res.writeHead(400).end();return}
  requests.push(body);const count=requests.length;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  emit('message_start',{message:{id:`msg_${crypto.randomUUID()}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}});
  if(count===1){
   emit('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_fixture',name:'Read',input:{}}});
   emit('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({file_path:fixture})}});
   releaseFirst=()=>{emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:3}});emit('message_stop',{});res.end()};firstSeen();
  }else{
   emit('content_block_start',{index:0,content_block:{type:'text',text:''}});emit('content_block_delta',{index:0,delta:{type:'text_delta',text:`TOOL_REPLY_${count}`}});emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});emit('message_stop',{});res.end();
  }
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const core='D:\\CodexArtifacts\\claude-code-desktop\\R378-NOTIFICATION-RELAY-HISTORY-ASAR\\resources\\agent-core';
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),TEMP:process.env.TEMP,TMP:process.env.TMP,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'synthetic-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
 const child=spawn(path.join(core,'bun/bun.exe'),[path.join(core,'claude-code/dist/cli-bun.js'),'--print','--verbose','--input-format','stream-json','--output-format','stream-json','--replay-user-messages','--model','claude-sonnet-4-5','--allowedTools','Read'],{cwd:path.join(root,'work'),env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
 const frame=(text,uuid)=>JSON.stringify({type:'user',uuid,session_id:'fixture',parent_tool_use_id:null,message:{role:'user',content:text}})+'\n';
 let deadline;
 try{
  child.stdin.write(frame('FIRST_TOOL_SYNTHETIC',ids[0]));
  await Promise.race([first,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error(`first request not seen: ${stderr.slice(-500)}`)),15000)})]);clearTimeout(deadline);
  child.stdin.write(frame('SECOND_TOOL_SYNTHETIC',ids[1]));releaseFirst();releaseFirst=null;
  for(let i=0;i<160&&(stdout.match(/"type":"result"/g)||[]).length<1;i++)await new Promise(r=>setTimeout(r,100));
  await new Promise(r=>setTimeout(r,500));
  const frames=stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
  const report={realAccount:false,realModel:false,inputIds:ids,requests:requests.length,toolReadSeen:requests.some(x=>JSON.stringify(x.messages).includes('SYNTHETIC_READ_CONTENT')),secondSeen:requests.some(x=>JSON.stringify(x.messages).includes('SECOND_TOOL_SYNTHETIC')),frames:frames.map(f=>({type:f.type,subtype:f.subtype,uuid:f.uuid,command_uuid:f.command_uuid,state:f.state,isReplay:f.isReplay,parent_tool_use_id:f.parent_tool_use_id,content:JSON.stringify(f.message?.content??null)})),stderr:stderr.slice(-500)};
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));t.diagnostic(`report: ${path.join(root,'report.json')}`);
  assert.equal(report.toolReadSeen,true);assert.equal(report.secondSeen,true);
  assert.deepEqual(report.frames.filter(frame=>frame.type==='user'&&frame.isReplay===true).map(frame=>frame.uuid),ids);
  assert.ok(JSON.stringify(requests[1].messages).includes('SYNTHETIC_READ_CONTENT'));
  assert.ok(JSON.stringify(requests[1].messages).includes('SECOND_TOOL_SYNTHETIC'));
  assert.equal(report.frames.filter(f=>f.type==='result'&&f.subtype==='success').length,1);
 }finally{clearTimeout(deadline);if(releaseFirst)releaseFirst();child.stdin.end();if(child.exitCode===null)child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
