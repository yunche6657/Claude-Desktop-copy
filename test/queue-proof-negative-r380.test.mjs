import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const require=createRequire(import.meta.url);
const proof=fileURLToPath(new URL('../tools/proof-hidden-history-import-confirm.cjs',import.meta.url));
const source=fs.readFileSync(proof,'utf8');
const {createSessionKernel}=require('../desktop/session-kernel.cjs');
const {verifyFinalModelReceipts,verifyFinalRun}=require(proof);
const markers=['PRIOR_USER','FOLLOWUP','QUEUED_C','QUEUED_A','AFTER_ADMISSION'];
const receipts=()=>markers.map(lastUserMarker=>({lastUserMarker,cancelled:false,preDispatchCancelled:false,disposedInput:false}));

// Evaluate the unchanged proof, exposing only its existing functions in a VM.
// No Electron, sockets, desktop, account data, or package are opened by this harness.
function loadProof({fakeFs=fs,childProcess={},processEnv={},WebSocket}={}){
  const module={exports:{}};
  const fakeProcess={env:processEnv,argv:[process.execPath,proof,'fake.exe',path.resolve('audit-evidence')],execPath:process.execPath};
  const localRequire=name=>name==='node:fs'?fakeFs:name==='node:child_process'?childProcess:
    name==='../desktop/startup-defaults.cjs'?{applyStartupDefaults(){}}:require(name);
  const context=vm.createContext({require:localRequire,module,process:fakeProcess,__filename:proof,
    console,WebSocket,setTimeout,clearTimeout});
  vm.runInContext(source+'\nmodule.exports.audit={runHidden,runIsolatedProofParent};',context,{filename:proof});
  return {functions:module.exports.audit,process:fakeProcess};
}

async function runHiddenWith({code=0,report={ok:true,packaged:true}}={}){
  const child=new EventEmitter();child.exitCode=null;
  const log='Debugger listening on ws://127.0.0.1:1/synthetic';
  const fakeFs={openSync(){return 1},readFileSync(filename){return filename.endsWith('main.log')?log:JSON.stringify(report)}};
  class Socket extends EventEmitter {
    constructor(){super();queueMicrotask(()=>this.emit('open'));}
    addEventListener(name,listener,options){options?.once?this.once(name,listener):this.on(name,listener);}
    send(text){
      const {id,method}=JSON.parse(text);
      queueMicrotask(()=>{
        this.emit('message',{data:JSON.stringify({id,result:{}})});
        if(method==='Runtime.runIfWaitingForDebugger')this.emit('message',{data:JSON.stringify({method:'Debugger.paused',params:{callFrames:[{callFrameId:'synthetic'}]}})});
        if(method==='Debugger.resume')setImmediate(()=>{child.exitCode=code;child.emit('exit',code,code===null?'SIGTERM':null)});
      });
    }
    close(){this.emit('close');}
  }
  const {functions}=loadProof({fakeFs,WebSocket:Socket});
  let timer;
  try{return await functions.runHidden({exe:'synthetic.exe',root:'synthetic',workspace:'.',env:{},
    spawn(_exe,_args,options){assert.equal(options.windowsHide,true);return child},
    setChild(){},setFd(){},setTimer(value){timer=value}});
  }finally{clearTimeout(timer);}
}

test('proof inspector harness accepts a packaged successful exit as its positive control',async()=>{
  assert.equal((await runHiddenWith()).ok,true);
});

test('success JSON cannot conceal a nonzero or signalled packaged child exit',async()=>{
  for(const code of [17,null])await assert.rejects(runHiddenWith({code,report:{ok:true,packaged:true,error:'synthetic exit mismatch'}}),{name:'AssertionError'});
});

test('zero exit cannot conceal a failed proof report or an unpackaged process',async()=>{
  await assert.rejects(runHiddenWith({report:{ok:false,packaged:true,error:'synthetic turn failure'}}),/synthetic turn failure/);
  await assert.rejects(runHiddenWith({report:{ok:true,packaged:false}}),{name:'AssertionError'});
});

test('isolated parent preserves failed exits and strips inherited provider/preload overrides',()=>{
  for(const status of [23,null]){
    let options;
    const isolated=loadProof({processEnv:{SystemRoot:'synthetic-system',PATH:'synthetic-path',
      ANTHROPIC_API_KEY:'synthetic-secret',NODE_OPTIONS:'--require synthetic-preload',CLAUDE_AGENT_KERNEL:'local'},
      childProcess:{spawnSync(_exe,_args,opts){options=opts;return {status}}}});
    isolated.functions.runIsolatedProofParent();
    assert.equal(isolated.process.exitCode,status??1);
    assert.equal(options.windowsHide,true);
    assert.equal(options.env.CCD_HISTORY_PARENT_ISOLATED,'1');
    for(const key of ['ANTHROPIC_API_KEY','NODE_OPTIONS','CLAUDE_AGENT_KERNEL'])assert.equal(Object.hasOwn(options.env,key),false);
    for(const key of ['TEMP','TMP','TMPDIR'])assert.equal(options.env[key],'D:\\CodexArtifacts\\claude-code-desktop\\tmp');
  }
});

test('isolated parent propagates failure to launch instead of manufacturing a zero exit',()=>{
  const failure=new Error('synthetic spawn failure');
  const {functions}=loadProof({childProcess:{spawnSync(){return {error:failure,status:null}}}});
  assert.throws(()=>functions.runIsolatedProofParent(),error=>error===failure);
});

test('actual proof CLI exits nonzero for a missing package before creating evidence',()=>{
  const env={CCD_HISTORY_PARENT_ISOLATED:'1'};
  for(const key of ['SystemRoot','windir','PATH','ComSpec','PATHEXT'])if(process.env[key])env[key]=process.env[key];
  for(const key of ['TEMP','TMP','TMPDIR'])env[key]='D:\\CodexArtifacts\\claude-code-desktop\\tmp';
  const root=path.join(env.TEMP,`r380-negative-never-created-${process.pid}`);
  assert.equal(fs.existsSync(root),false);
  const result=spawnSync(process.execPath,[proof,path.join(root,'missing.exe'),root],{env,windowsHide:true,encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined);assert.equal(result.status,1);
  assert.match(result.stderr,/existing absolute packaged exe required/);
  assert.equal(fs.existsSync(root),false);
});

test('parent PID verification rejects a live backend and never treats EPERM as an exited process',()=>{
  // Exercise the actual inline parent guard without spawning or signalling a process.
  const begin=source.indexOf('  const ownedBackendPids=[...new Set(');
  const end=source.indexOf('  const verification=',begin);
  assert.ok(begin>=0&&end>begin,'parent ownership guard must remain identifiable');
  const guard=source.slice(begin,end),seen=[];
  const context=kill=>({assert,seedPids:[41],childReport:{ownedBackendPids:[42,42]},process:{kill}});
  assert.throws(()=>vm.runInNewContext(guard,context(()=>{})),/owned backend process still alive: 41/);
  const denied=Object.assign(new Error('synthetic permission denied'),{code:'EPERM'});
  assert.throws(()=>vm.runInNewContext(guard,context(()=>{throw denied})),error=>error===denied);
  vm.runInNewContext(guard,context((pid,signal)=>{seen.push(pid);assert.equal(signal,0);throw Object.assign(new Error('synthetic exited'),{code:'ESRCH'})}));
  assert.deepEqual(seen,[41,42]);
});

const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333'];
const replies=['R378_HISTORY_PRIOR_ASSISTANT','R380_REPLY_FOLLOWUP','R380_REPLY_C','R380_REPLY_A','R380_REPLY_RECOVERY'];
const sonnet='claude-sonnet-4-5',haiku='claude-haiku-4-5';
const modelSwitch={from:sonnet,to:haiku,pid:1234,ack:{id:'set_model-2',subtype:'success'}};

test('failed final turn is rejected even with all five requests received and the host idle',async t=>{
  const requests=[],events=[],results=[];
  const backend={id:'synthetic',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},
    async sendMessage(_id,message){
      const index=markers.indexOf(message.slice('R378_HISTORY_'.length));
      requests.push({...receipts()[index],model:index===4?haiku:sonnet});
      if(index===4)throw Error('synthetic final response decode failure');
      results.push({subtype:'success',isError:false,stopReason:'end_turn',text:replies[index]});
      return {text:replies[index]};
    }};
  const kernel=createSessionKernel({backend,emit:event=>events.push(event)});
  t.after(()=>kernel.dispose());
  const id='local_r380_negative';kernel.start({sessionId:id});
  for(const [index,marker] of markers.entries()){
    assert.equal((await kernel.start({sessionId:id,message:'R378_HISTORY_'+marker,messageUuid:ids[index]})).sessionId,id);
    await new Promise(setImmediate);
  }
  assert.equal(kernel.getSession(id).isRunning,false);
  assert.deepEqual(kernel.getQueuedMessages(id),[]);
  assert.equal(events.filter(event=>event.type==='turn_finished').length,4);
  assert.equal(kernel.getTranscript(id).at(-1).type,'user');
  const report={ok:true,requests:structuredClone(requests),resumedResults:results.slice(1),modelSwitch,ownedBackendPids:[1234]};
  assert.deepEqual(verifyFinalModelReceipts(requests,report),markers);
  assert.throws(()=>verifyFinalRun(requests,report,results.slice(0,1),kernel.getTranscript(id)),/missing or extra native terminal result/);
});

test('success requires native success, the matching stored reply and the selected model',()=>{
  const requests=receipts().map((row,index)=>({...row,model:index===4?haiku:sonnet}));
  const results=replies.map(text=>({subtype:'success',isError:false,stopReason:'end_turn',text}));
  const rows=markers.flatMap((marker,index)=>[
    {type:'user',uuid:ids[index],message:{role:'user',content:[{type:'text',text:'R378_HISTORY_'+marker}]}},
    {type:'assistant',parentUuid:ids[index],message:{role:'assistant',content:[{type:'text',text:replies[index]}]}}
  ]);
  const run=()=>verifyFinalRun(requests,{ok:true,requests:structuredClone(requests),resumedResults:results.slice(1),modelSwitch,ownedBackendPids:[1234]},results.slice(0,1),rows);
  assert.equal(run().completedTurns.length,5);
  for(const key of ['isError','stopReason','text']){
    const saved=results[4][key];results[4][key]={isError:true,stopReason:'cancelled',text:replies[1]}[key];
    assert.throws(run,/terminal result for AFTER_ADMISSION/);results[4][key]=saved;
  }
  rows[9].parentUuid=ids[3];assert.throws(run,/different user/);rows[9].parentUuid=ids[4];
  rows[9].message.content[0].text=replies[1];assert.throws(run,/wrong stored reply/);rows[9].message.content[0].text=replies[4];
  requests[4].model=sonnet;assert.throws(run,{name:'AssertionError'});
});
