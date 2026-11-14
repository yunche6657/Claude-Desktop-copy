import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createSessionKernel } = createRequire(import.meta.url)('../desktop/session-kernel.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
 let actor = 'one', state = 'disabled', finish; const calls = [], events = [];
 const backend = { id:'ccb', start() {}, cancel() {}, dispose() {}, onEvent() { return () => {}; },
  getInfo() { return {actorToken:actor}; },
  async mcpServerStatus(_id, token) { return {actorToken:token,servers:[{name:'srv',status:state,scope:'project',config:{url:'https://fixture.invalid',secret:'private'}}]}; },
  async toggleMcpServer(id, token, name, enabled) { calls.push({id,token,name,enabled}); state='connected'; return {actorToken:token}; },
  async reconnectMcpServer() { throw Error('must not be invoked without binding'); },
  sendMessage() { return new Promise(resolve => { finish=resolve; }); } };
 const kernel=createSessionKernel({backend,emit:event=>events.push(event)}); kernel.start({sessionId:'s'});
 return {kernel,calls,events,finish:()=>finish({}),replace:()=>actor='two'};
}
test('actor-bound enable uses private status; absent auth provenance blocks reconnect and retry', async t => {
 const f=fixture(); t.after(()=>f.kernel.dispose()); await f.kernel.refreshCliMcpStatus('s');
 assert.equal(JSON.stringify(f.kernel.getCliMcpStatus('s')).includes('private'),false);
 assert.match((await f.kernel.mcpReconnect('s','srv')).error,/verify/);
 assert.deepEqual(await f.kernel.mcpEnableServer('s','srv'),{});
 assert.deepEqual(f.calls,[{id:'s',token:'one',name:'srv',enabled:true}]);
});
test('held enable runs after its turn and is discarded when actor changes', async t => {
 const f=fixture(); t.after(()=>f.kernel.dispose()); await f.kernel.refreshCliMcpStatus('s');
 const turn=f.kernel.sendMessage('s','fixture'); await tick();
 assert.deepEqual(await f.kernel.mcpEnableServer('s','srv'),{queued:true,error:'Turn in progress'});
 assert.equal(f.calls.length,0); f.finish(); await turn;
 for(let i=0;i<10&&!f.calls.length;i++) await tick();
 assert.equal(f.calls.length,1);
 const g=fixture(); t.after(()=>g.kernel.dispose()); await g.kernel.refreshCliMcpStatus('s');
 const turn2=g.kernel.sendMessage('s','fixture'); await tick(); await g.kernel.mcpEnableServer('s','srv');
 g.replace(); g.finish(); await turn2; await g.kernel.refreshCliMcpStatus('s'); await tick();
 assert.equal(g.calls.length,0);
});
test('retry without an existing auth binding targets only the current session actor', async t => {
 let actor='actor-a', status='failed'; const calls=[];
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},async sendMessage(){},
  getInfo(){return{actorToken:actor}},
  async mcpServerStatus(_id,token){return{actorToken:token,servers:[{name:'srv',status,scope:'project'}]}},
  async reconnectMcpServer(id,token,name){calls.push({id,token,name});status='connected';return{actorToken:token}}};
 const kernel=createSessionKernel({backend,emit(){}});t.after(()=>kernel.dispose());kernel.start({sessionId:'s'});
 await kernel.refreshCliMcpStatus('s');
 assert.deepEqual(await kernel.mcpRetryConnection('s','srv'),{});
 assert.deepEqual(calls,[{id:'s',token:'actor-a',name:'srv'}]);
 assert.match((await kernel.mcpReconnect('s','srv')).error,/verify/);
 actor='actor-b';
 assert.match((await kernel.mcpRetryConnection('s','srv')).error,/state unavailable/);
 assert.equal(calls.length,1);
});
test('retry reports the original URL-origin redaction for an actual control error', async t => {
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},async sendMessage(){},
  getInfo(){return{actorToken:'actor'}},
  async mcpServerStatus(_id,token){return{actorToken:token,servers:[{name:'srv',status:'failed',scope:'project'}]}},
  async reconnectMcpServer(){throw new Error('Connection failed https://user:pass@example.test/private?secret=fixture')}};
 const kernel=createSessionKernel({backend,emit(){}});t.after(()=>kernel.dispose());kernel.start({sessionId:'s'});
 await kernel.refreshCliMcpStatus('s');
 assert.deepEqual(await kernel.mcpRetryConnection('s','srv'),{error:'Connection failed https://example.test'});
});
test('requeued enable survives a turn ending during preflight', async () => {
 for (let offset=0; offset<40; offset++) {
  let state='disabled', polls=0, releasePoll, finishTurn; const events=[], calls=[];
  const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},getInfo(){return {actorToken:'actor'}},
   async mcpServerStatus(_id,token) { if (++polls===2) await new Promise(resolve=>{releasePoll=resolve}); return {actorToken:token,servers:[{name:'srv',status:state,scope:'project'}]}; },
   async toggleMcpServer(id,token,name,enabled){calls.push({id,token,name,enabled});state='connected';return {actorToken:token}},
   sendMessage(){return new Promise(resolve=>{finishTurn=resolve})} };
  const kernel=createSessionKernel({backend,emit:e=>events.push(e)}); kernel.start({sessionId:'s'});
  try {
   await kernel.refreshCliMcpStatus('s');
   const first=kernel.sendMessage('s','first'); await tick();
   assert.equal((await kernel.mcpEnableServer('s','srv')).queued,true);
   finishTurn({}); await first;
   for(let i=0;i<10&&!releasePoll;i++) await tick();
   assert.equal(typeof releasePoll,'function');
   const second=kernel.sendMessage('s','second'); await tick();
   releasePoll();
   let n=offset;
   const finishSoon=()=>{if(n-->0) queueMicrotask(finishSoon); else finishTurn({});};
   queueMicrotask(finishSoon);
   await second;
   for(let i=0;i<15&&!calls.length;i++) await tick();
   assert.equal(calls.length,1,`offset ${offset}: ${JSON.stringify(events.filter(e=>e.type==='session_mcp_held_verb_failed'))}`);
   assert.equal(events.some(e=>e.type==='session_mcp_held_verb_failed'),false,`offset ${offset}`);
  } finally {kernel.dispose()}
 }
});
test('requeued enable cannot cross actor replacement while preflight is pending', async () => {
 let actor='old', polls=0, releasePoll, finishTurn; const calls=[];
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},getInfo(){return {actorToken:actor}},
  async mcpServerStatus(_id,token){if(++polls===2) await new Promise(resolve=>{releasePoll=resolve});return {actorToken:token,servers:[{name:'srv',status:'disabled',scope:'project'}]}},
  async toggleMcpServer(...args){calls.push(args);return {actorToken:args[1]}},sendMessage(){return new Promise(resolve=>{finishTurn=resolve})}};
 const kernel=createSessionKernel({backend,emit(){}});kernel.start({sessionId:'s'});
 try {
  await kernel.refreshCliMcpStatus('s');const first=kernel.sendMessage('s','first');await tick();
  assert.equal((await kernel.mcpEnableServer('s','srv')).queued,true);finishTurn({});await first;
  for(let i=0;i<10&&!releasePoll;i++)await tick();
  const second=kernel.sendMessage('s','second');await tick();releasePoll();await tick();
  actor='new';finishTurn({});await second;await kernel.refreshCliMcpStatus('s');await tick();
  assert.deepEqual(calls,[]);
 } finally {kernel.dispose()}
});
