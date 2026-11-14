import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createSessionKernel}=createRequire(import.meta.url)('../desktop/session-kernel.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
 let actor='a',status='needs-auth',finish;const calls=[],events=[],listeners=new Set();
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn)},getInfo(){return {actorToken:actor}},
  async mcpServerStatus(_id,token){return{actorToken:token,servers:[{name:'srv',status,scope:'project',config:{type:'http',url:'https://example.test/mcp'}}]}},
  async authenticateMcpServer(_id,token){return{actorToken:token,requiresUserAction:true,authUrl:'https://example.test/auth',flowId:'flow'}},
  async clearMcpAuth(id,token,name){calls.push(['clear',id,token,name]);status='failed';return{actorToken:token}},
  async reconnectMcpServer(id,token,name){calls.push(['reconnect',id,token,name]);status='connected';return{actorToken:token}},
  sendMessage(){return new Promise(resolve=>{finish=resolve})}};
 const kernel=createSessionKernel({backend,emit:e=>events.push(e)});kernel.start({sessionId:'s'});
 return {kernel,calls,events,finish:()=>finish({}),changeActor:()=>actor='b',close:()=>{actor=null;for(const fn of listeners)fn({type:'query_closed',sessionId:'s',actorToken:null})}};
}
test('busy clear queues, is projected to the renderer, and takes priority over reconnect',async t=>{
 const f=setup();t.after(()=>f.kernel.dispose());await f.kernel.refreshCliMcpStatus('s');assert.ok((await f.kernel.mcpAuthenticateConfigServer('s','srv')).authUrl);
 const turn=f.kernel.sendMessage('s','fixture');await tick();
 assert.deepEqual(await f.kernel.mcpClearAuth('s','srv'),{queued:true,error:'Turn in progress'});
 assert.equal(f.kernel.getSession('s').sdkMcpServers[0].pendingAction,'clear-auth');
 assert.deepEqual(await f.kernel.mcpReconnect('s','srv'),{queued:true,error:'Turn in progress'});
 assert.equal(f.kernel.getSession('s').sdkMcpServers[0].pendingAction,'clear-auth');assert.deepEqual(f.calls,[]);
 f.finish();await turn;for(let i=0;i<30&&!f.calls.length;i++)await tick();
 assert.deepEqual(f.calls,[['clear','s','a','srv']]);for(let i=0;i<10&&f.kernel.getSession('s').sdkMcpServers[0].pendingAction;i++)await tick();
 assert.equal(f.kernel.getSession('s').sdkMcpServers[0].pendingAction,undefined);
 assert.ok(f.events.some(e=>e.type==='session_updated'&&e.session?.sdkMcpServers?.[0]?.pendingAction==='clear-auth'));
});
test('queued clear does not cross actor replacement',async t=>{
 const f=setup();t.after(()=>f.kernel.dispose());await f.kernel.refreshCliMcpStatus('s');
 const turn=f.kernel.sendMessage('s','fixture');await tick();assert.equal((await f.kernel.mcpClearAuth('s','srv')).queued,true);
 f.changeActor();f.finish();await turn;await f.kernel.refreshCliMcpStatus('s');await tick();assert.deepEqual(f.calls,[]);
});
test('a stale held clear cannot swallow the new actor clear',async t=>{
 const f=setup();t.after(()=>f.kernel.dispose());await f.kernel.refreshCliMcpStatus('s');
 const turn=f.kernel.sendMessage('s','fixture');await tick();assert.equal((await f.kernel.mcpClearAuth('s','srv')).queued,true);
 f.changeActor();await f.kernel.refreshCliMcpStatus('s');assert.equal(f.kernel.getSession('s').sdkMcpServers[0].pendingAction,undefined);
 assert.equal((await f.kernel.mcpClearAuth('s','srv')).queued,true);assert.equal(f.kernel.getSession('s').sdkMcpServers[0].pendingAction,'clear-auth');
 f.finish();await turn;for(let i=0;i<30&&!f.calls.length;i++)await tick();assert.deepEqual(f.calls,[['clear','s','b','srv']]);
 assert.ok(f.events.some(e=>e.type==='session_mcp_held_verb_failed'&&JSON.parse(e.data).error==='Session not running'));
});
test('a queued clear fails visibly when its actor closes before dispatch',async t=>{
 const f=setup();t.after(()=>f.kernel.dispose());await f.kernel.refreshCliMcpStatus('s');
 const turn=f.kernel.sendMessage('s','fixture');await tick();assert.equal((await f.kernel.mcpClearAuth('s','srv')).queued,true);
 f.close();const failure=f.events.find(e=>e.type==='session_mcp_held_verb_failed');assert.ok(failure);
 const {serverName,verb,error}=JSON.parse(failure.data);assert.deepEqual({serverName,verb,error},{serverName:'srv',verb:'clear-auth',error:'Session not running'});
 f.finish();await turn;await tick();assert.deepEqual(f.calls,[]);
});
test('actor close during queued clear preflight emits failure before any control is sent',async t=>{
 let actor='a',polls=0,finish,release;const listeners=new Set(),calls=[],events=[];
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn)},getInfo(){return{actorToken:actor}},
  async mcpServerStatus(_id,token){if(++polls===2)await new Promise(r=>release=r);return{actorToken:token,servers:[{name:'srv',status:'needs-auth',scope:'project',config:{type:'http',url:'https://example.test/mcp'}}]}},
  async clearMcpAuth(...args){calls.push(args);return{actorToken:args[1]}},sendMessage(){return new Promise(r=>finish=r)}};
 const kernel=createSessionKernel({backend,emit:e=>events.push(e)});t.after(()=>kernel.dispose());kernel.start({sessionId:'s'});await kernel.refreshCliMcpStatus('s');
 const turn=kernel.sendMessage('s','fixture');await tick();assert.equal((await kernel.mcpClearAuth('s','srv')).queued,true);finish({});await turn;
 for(let i=0;i<20&&!release;i++)await tick();assert.equal(typeof release,'function');assert.equal(kernel.getSession('s').sdkMcpServers[0].pendingActionRunning,true);
 actor=null;for(const fn of listeners)fn({type:'query_closed',sessionId:'s',actorToken:null});
 const failure=events.find(e=>e.type==='session_mcp_held_verb_failed');assert.ok(failure);assert.equal(JSON.parse(failure.data).error,'Session not running');
 release();await tick();assert.deepEqual(calls,[]);
});
test('replacement actor reports the old unsent preflight and queues its own clear',async t=>{
 let actor='a',polls=0,finish,release;const calls=[],events=[];
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},getInfo(){return{actorToken:actor}},
  async mcpServerStatus(_id,token){if(++polls===2)await new Promise(r=>release=r);return{actorToken:token,servers:[{name:'srv',status:'needs-auth',scope:'project',config:{type:'http',url:'https://example.test/mcp'}}]}},
  async clearMcpAuth(...args){calls.push(args);return{actorToken:args[1]}},sendMessage(){return new Promise(r=>finish=r)}};
 const kernel=createSessionKernel({backend,emit:e=>events.push(e)});t.after(()=>kernel.dispose());kernel.start({sessionId:'s'});await kernel.refreshCliMcpStatus('s');
 const first=kernel.sendMessage('s','first');await tick();assert.equal((await kernel.mcpClearAuth('s','srv')).queued,true);finish({});await first;
 for(let i=0;i<20&&!release;i++)await tick();assert.equal(typeof release,'function');
 actor='b';await kernel.refreshCliMcpStatus('s');const second=kernel.sendMessage('s','second');await tick();assert.equal((await kernel.mcpClearAuth('s','srv')).queued,true);
 const failure=events.find(e=>e.type==='session_mcp_held_verb_failed');assert.ok(failure);assert.equal(JSON.parse(failure.data).error,'Session not running');
 release();await tick();finish({});await second;for(let i=0;i<20&&!calls.length;i++)await tick();assert.equal(calls.length,1);assert.equal(calls[0][1],'b');
});
test('actor close does not label an already dispatched queued clear as unsent',async t=>{
 let actor='a',finish,release;const listeners=new Set(),events=[];
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn)},getInfo(){return{actorToken:actor}},
  async mcpServerStatus(_id,token){return{actorToken:token,servers:[{name:'srv',status:'needs-auth',scope:'project',config:{type:'http',url:'https://example.test/mcp'}}]}},
  async clearMcpAuth(){return new Promise(r=>release=r)},sendMessage(){return new Promise(r=>finish=r)}};
 const kernel=createSessionKernel({backend,emit:e=>events.push(e)});t.after(()=>kernel.dispose());kernel.start({sessionId:'s'});await kernel.refreshCliMcpStatus('s');
 const turn=kernel.sendMessage('s','fixture');await tick();assert.equal((await kernel.mcpClearAuth('s','srv')).queued,true);finish({});await turn;
 for(let i=0;i<20&&!release;i++)await tick();assert.equal(typeof release,'function');
 actor=null;for(const fn of listeners)fn({type:'query_closed',sessionId:'s',actorToken:null});
 assert.equal(events.some(e=>e.type==='session_mcp_held_verb_failed'),false);release({actorToken:'a'});await tick();
});
