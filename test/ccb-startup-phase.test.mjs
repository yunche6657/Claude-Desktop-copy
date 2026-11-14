import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createCcbKernel}=createRequire(import.meta.url)('../desktop/ccb-kernel.cjs');
test('initialization completes before a delayed provider response and warm turns skip startup',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'ccb-phase-')),entry=path.join(dir,'cli.cjs');
 writeFileSync(entry,`const rl=require('readline').createInterface({input:process.stdin});const out=o=>console.log(JSON.stringify(o));rl.on('line',line=>{const f=JSON.parse(line);if(f.type==='control_request')out({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{models:[]}}});if(f.type==='user')setTimeout(()=>{out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'OK'}]}});out({type:'result',subtype:'success',result:'OK',stop_reason:'end_turn'});},150);});`);
 const kernel=createCcbKernel({bunPath:process.execPath,entryPath:entry,kernelRoot:dir,cwd:dir,homeDir:path.join(dir,'home'),scratchDir:path.join(dir,'scratch'),turnTimeoutMs:5000});
 t.after(()=>kernel.dispose());const events=[];kernel.onEvent(e=>events.push(e));
 const result=await kernel.sendMessage('phase','hi');assert.equal(result.text,'OK');
 const phases=events.filter(e=>e.type==='initialization_status').map(e=>e.initializationStatus);
 assert.deepEqual(phases,[{step:'starting',isComplete:false},{step:'starting',isComplete:true},{step:'model_request',isComplete:false}]);
 assert.ok(events.findIndex(e=>e.type==='initialization_status'&&e.initializationStatus.step==='model_request')<events.findIndex(e=>e.type==='text'));
 events.length=0;await kernel.sendMessage('phase','again');
 assert.deepEqual(events.filter(e=>e.type==='initialization_status').map(e=>e.initializationStatus),[{step:'model_request',isComplete:false}]);
});
