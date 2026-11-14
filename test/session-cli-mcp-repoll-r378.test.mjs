import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {createSessionKernel}=createRequire(import.meta.url)('../desktop/session-kernel.cjs');
const source=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js',import.meta.url),'utf8');
const start=source.indexOf('schedulePendingMcpRepoll(e,t,n,r){'),end=source.indexOf('recordInternalMcpNameClaims(',start);
assert.ok(start>=0&&end>start);
function timers(){let next=0;const active=new Map(),delays=[];return {active,delays,setTimer(fn,ms){const id=++next;active.set(id,fn);delays.push(ms);return id},clearTimer(id){active.delete(id)},async fire(){const [id,fn]=active.entries().next().value;active.delete(id);fn();await new Promise(resolve=>setImmediate(resolve));}}}
function nativeHarness(){const clock=timers(),query={},session={query};let status='pending';let handler;
 const ctx={UA:[2000,5000,15000,30000,60000],setTimeout:clock.setTimer,clearTimeout:clock.clearTimer};
 handler=vm.runInNewContext(`(function ${source.slice(start,end)})`,ctx);
 const owner={schedule:handler,refreshSdkMcpStatuses(s){handler.call(owner,s,query,[{status}],{firstOfProcess:false})}};
 return {clock,first(value){status=value;handler.call(owner,session,query,[{status}],{firstOfProcess:true})},set(value){status=value}};
}
function replicaHarness(){const clock=timers(),listeners=new Set();let actor='actor',status='pending';
 const backend={id:'ccb',start(){},async sendMessage(){},cancel(){},dispose(){},onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn)},getInfo(){return {actorToken:actor}},async mcpServerStatus(){return {actorToken:actor,servers:[{name:'fixture',status}]}}};
 const kernel=createSessionKernel({backend,emit(){},mcpPollClock:clock});kernel.start({sessionId:'s'});
 return {clock,kernel,set(value){status=value},close(){actor=null;for(const fn of listeners)fn({type:'query_closed',sessionId:'s',actorToken:null})},replace(){actor='other'}};
}
test('repoll delays and pending stop match original bounded schedule',async()=>{
 const n=nativeHarness(),r=replicaHarness();n.first('pending');r.set('pending');assert.equal(await r.kernel.refreshCliMcpStatus('s'),true);
 for(let i=0;i<5;i++){assert.equal(n.clock.active.size,1);assert.equal(r.clock.active.size,1);await n.clock.fire();await r.clock.fire();}
 assert.deepEqual(r.clock.delays,n.clock.delays);assert.deepEqual(r.clock.delays,[2000,5000,15000,30000,60000]);assert.equal(r.clock.active.size,0);r.kernel.dispose();
});
test('first successful nonpending status gets one check; close and dispose cancel timers',async()=>{
 const n=nativeHarness(),r=replicaHarness();n.first('connected');r.set('connected');await r.kernel.refreshCliMcpStatus('s');assert.deepEqual(r.clock.delays,n.clock.delays);await n.clock.fire();await r.clock.fire();assert.equal(n.clock.active.size,0);assert.equal(r.clock.active.size,0);
 r.set('pending');await r.kernel.refreshCliMcpStatus('s');assert.equal(r.clock.active.size,1);r.close();assert.equal(r.clock.active.size,0);r.replace();await r.kernel.refreshCliMcpStatus('s');assert.equal(r.clock.active.size,1);r.kernel.dispose();assert.equal(r.clock.active.size,0);
});
test('an older first success still schedules a follow-up when a newer poll stalls',async()=>{
 const clock=timers(),pending=[];
 const backend={id:'ccb',start(){},async sendMessage(){},cancel(){},dispose(){},onEvent(){return()=>{}},getInfo(){return{actorToken:'actor'}},mcpServerStatus(){return new Promise((resolve,reject)=>pending.push({resolve,reject}))}};
 const kernel=createSessionKernel({backend,emit(){},mcpPollClock:clock});kernel.start({sessionId:'s'});
 const older=kernel.refreshCliMcpStatus('s'),newer=kernel.refreshCliMcpStatus('s');
 pending[0].resolve({actorToken:'actor',servers:[{name:'fixture',status:'pending'}]});
 assert.equal(await older,false);assert.deepEqual(clock.delays,[2000]);assert.equal(clock.active.size,1);
 pending[1].reject(new Error('fixture failure'));assert.equal(await newer,false);
 assert.equal(clock.active.size,1);kernel.dispose();assert.equal(clock.active.size,0);
});
