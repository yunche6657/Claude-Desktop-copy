import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const require=createRequire(import.meta.url);
const {createCcbKernel}=require('../desktop/ccb-kernel.cjs');
// A separate real OS process implements a controlled stream-json peer. It is a
// fixture, not the packaged CLI or a real inference service.
const fixture=String.raw`
const readline=require('node:readline');
const send=f=>process.stdout.write(JSON.stringify(f)+'\n');
let pending=false;
send({type:'system',subtype:'init',session_id:'fixture-session',model:'fixture',cwd:process.cwd(),tools:[]});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const f=JSON.parse(line);
 if(f.type==='control_request'&&f.request?.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{commands:[],agents:[],models:[]}}});
 if(f.type==='fixture_frame')send(f.frame);
 if(f.type==='user')pending=true;
 if(f.type==='fixture_release' && pending){pending=false;send({type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',result:'fixture reply',session_id:'fixture-session'});}
});
`;
async function until(check){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('fixture frame deadline');}
test('fixture process: raw protection, stale candidate, actual child eviction and new epoch',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'r368-'));const entry=path.join(dir,'fixture.cjs');writeFileSync(entry,fixture);
 let child;const backend=createCcbKernel({bunPath:process.execPath,entryPath:entry,kernelRoot:dir,startupTimeoutMs:5000,disposeTimeoutMs:1000,spawnImpl:(...args)=>child=spawn(...args)});
 t.after(async()=>{await backend.dispose();rmSync(dir,{recursive:true,force:true});});
 backend.start({sessionId:'fixture',cwd:dir});await backend.initialize('fixture');
 const first=backend.getActiveProcesses()[0];assert.ok(first.pid>0);assert.equal(first.protection.flags.backgroundTasks,false);assert.equal(first.protection.coverage.backgroundSnapshot,false);
 const candidate={pid:first.pid,actorToken:first.actorToken,protectionVersion:first.protection.version};
 const emit=async frame=>{const before=backend.getProtectionState('fixture').version;child.stdin.write(JSON.stringify({type:'fixture_frame',frame})+'\n');await until(()=>backend.getProtectionState('fixture')?.version>before);};
 await emit({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'x',task_type:'local_bash'}]});
 assert.equal(backend.getProtectionState('fixture').flags.backgroundTasks,true);
 assert.equal((await backend.evictSession('fixture',candidate)).reason,'protected');
 await emit({type:'system',subtype:'background_tasks_changed',tasks:[]});
 assert.equal(backend.getProtectionState('fixture').flags.backgroundTasks,false);
 assert.equal((await backend.evictSession('fixture',candidate)).reason,'stale-candidate');
 const current=backend.getActiveProcesses()[0];const result=await backend.evictSession('fixture',{pid:current.pid,actorToken:current.actorToken,protectionVersion:current.protection.version});
 assert.equal(result.ok,true);assert.equal(result.pid,first.pid);await until(()=>!backend.getActiveProcesses().some(p=>p.pid===first.pid));
 await backend.warm('fixture',{cwd:dir});const next=backend.getActiveProcesses()[0];assert.notEqual(next.pid,first.pid);assert.notEqual(next.actorToken,first.actorToken);assert.equal(next.protection.coverage.backgroundSnapshot,false);
});


test('fixture process: synchronous validation reentry and async validation cannot kill a queued actor',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'r368-reentry-'));const entry=path.join(dir,'fixture.cjs');writeFileSync(entry,fixture);
 let child;const backend=createCcbKernel({bunPath:process.execPath,entryPath:entry,kernelRoot:dir,startupTimeoutMs:5000,disposeTimeoutMs:1000,turnTimeoutMs:5000,spawnImpl:(...args)=>child=spawn(...args)});
 t.after(async()=>{await backend.dispose();rmSync(dir,{recursive:true,force:true});});
 backend.start({sessionId:'fixture',cwd:dir});await backend.initialize('fixture');
 const initial=backend.getActiveProcesses()[0];assert.equal(initial.protection.nativeFlags.agentRun,false);
 const candidate={pid:initial.pid,actorToken:initial.actorToken,protectionVersion:initial.protection.version};
 const asynchronous=await backend.evictSession('fixture',{...candidate,validate:()=>Promise.resolve(true)});
 assert.equal(asynchronous.ok,false);assert.equal(asynchronous.reason,'stale-candidate');assert.equal(backend.getActiveProcesses()[0].pid,initial.pid);
 let turn;const rejected=await backend.evictSession('fixture',{...candidate,validate:()=>{turn=backend.sendMessage('fixture','hold');return true;}});
 assert.equal(rejected.ok,false);assert.equal(rejected.reason,'not-idle');assert.equal(backend.getActiveProcesses()[0].pid,initial.pid);
 await until(()=>backend.getProtectionState('fixture')?.nativeFlags.agentRun===true);
 assert.equal(backend.getProtectionState('fixture').nativeFlags.agentRun,true);
 child.stdin.write(JSON.stringify({type:'fixture_release'})+'\n');
 assert.equal((await turn).text,'fixture reply');
 await until(()=>backend.getProtectionState('fixture')?.nativeFlags.agentRun===false);
 assert.equal(backend.getProtectionState('fixture').nativeFlags.agentRun,false);assert.equal(backend.getActiveProcesses()[0].pid,initial.pid);
});
