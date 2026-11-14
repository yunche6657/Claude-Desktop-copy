import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

test('a second ordinary LocalSessions send settles before the active response, is visible by UUID and can be withdrawn', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const backend = {
    id:'fixture', start(){}, cancel(){}, dispose(){}, onEvent(){ return () => {}; },
    async sendMessage(_id, message) {
      assert.equal(message, 'first');
      started.resolve();
      await release.promise;
      return {text:'reply to first', stopReason:'end_turn'};
    }
  };
  const kernel = createSessionKernel({backend, emit(){}});
  const handlers = new Map();
  registerBridgeServices({
    ipcMain:{handle:(channel, fn) => handlers.set(channel, fn), removeHandler:channel => handlers.delete(channel)},
    bridgeMap: require('../desktop/shim/bridge-map.json'), getMainWindow:() => null,
    settings:{sidebarMode:'epitaxy', themeMode:'system', kernelFactory:() => kernel}, frontend:{root:process.cwd()}
  });
  const call = (method,...args) => {
    const match = [...handlers].find(([channel]) => channel.endsWith('_$_LocalSessions_$_' + method));
    assert.ok(match);
    return match[1]({},...args);
  };
  const id = kernel.start({cwd:process.env.CLAUDE_WORKSPACE}).sessionId;
  const uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const first = call('sendMessage',id,'first');
  try {
    await started.promise;
    const second = Promise.resolve(call('sendMessage',id,'second',undefined,undefined,undefined,undefined,undefined,uuid))
      .then(value => ({accepted:true,value}), error => ({accepted:false,reason:error.message}));
    const observed = await Promise.race([second, tick().then(() => ({pending:true}))]);
    assert.deepEqual(observed, {accepted:true,value:undefined});
    assert.deepEqual(kernel.getQueuedMessages(id),[{uuid}]);
    assert.equal(await call('cancelQueuedMessage',id,uuid),true);
    assert.deepEqual(kernel.getQueuedMessages(id),[]);
  } finally {
    release.resolve();
    await first;
    kernel.dispose();
  }
});

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', C='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function activeSession(t) {
  const submitted=[],events=[],started=Promise.withResolvers(),release=Promise.withResolvers();
  const backend={id:'fixture',start(){},cancel(){},dispose(){},onEvent(){return ()=>{}},
    async sendMessage(_id,text,options){
      submitted.push({text,uuid:options.messageUuid,images:options.images});
      if(submitted.length===1){started.resolve();await release.promise;}
      return {text:'fixture reply',stopReason:'end_turn'};
    }};
  const kernel=createSessionKernel({backend,emit:e=>events.push(e)});
  const id=kernel.start({}).sessionId;
  const first=kernel.sendMessage(id,'active',{messageUuid:A});
  await started.promise;
  t.after(async()=>{release.resolve();await first;kernel.dispose()});
  const queue=(text,messageUuid,extra)=>kernel.sendMessage(id,text,{messageUuid,deferIfBusy:true,plainInput:true,...extra});
  async function finish(){
    release.resolve();await first;
    for(let i=0;i<25&&(kernel.getSession(id)?.isRunning||kernel.getQueuedMessages(id).length);i++)await tick();
    assert.deepEqual(kernel.getQueuedMessages(id),[]);assert.equal(kernel.getSession(id).isRunning,false);
  }
  return {kernel,id,queue,finish,submitted,events};
}
test('busy text is echoed before dispatch, then reordered and coalesced under the first remaining UUID',async t=>{
  const {kernel,id,queue,finish,submitted,events}=await activeSession(t);
  await assert.rejects(kernel.sendMessage(id,'direct caller'),/already running/);
  await queue('second',B);await queue('third',C);
  assert.deepEqual(events.filter(e=>e.type==='message').map(e=>[e.message.uuid,e.message.message.content]),[[B,'second'],[C,'third']]);
  assert.equal(kernel.reorderQueuedMessage(id,C,B),true);
  assert.deepEqual(submitted.map(x=>x.text),['active']);await finish();
  assert.deepEqual(submitted.map(x=>[x.uuid,x.text]),[[A,'active'],[C,'third\n\nsecond']]);
  const prompts=kernel.getTranscript(id).filter(row=>row.type==='user');
  assert.deepEqual(prompts.map(row=>[row.uuid,row.message.content[0].text]),[[A,'active'],[C,'third\n\nsecond']]);
});
test('invalid images leave no queued message and a reused UUID is independently cancellable',async t=>{
  const {kernel,id,queue,submitted,events,finish}=await activeSession(t);
  await assert.rejects(queue('bad image',B,{images:[{}]}),/Invalid image/);
  assert.deepEqual(kernel.getQueuedMessages(id),[]);assert.equal(events.filter(e=>e.type==='message').length,0);
  await queue('reused active ID',A);
  const [{uuid}]=kernel.getQueuedMessages(id);assert.notEqual(uuid,A);assert.equal(events.at(-1).message.uuid,uuid);
  assert.equal(kernel.cancelQueuedMessage(id,uuid),true);assert.equal(kernel.cancelQueuedMessage(id,uuid),false);
  await finish();assert.deepEqual(submitted.map(x=>x.text),['active']);
});
test('command text after a formatting character stays separate from ordinary text',async t=>{
  const {queue,submitted,finish,events}=await activeSession(t);
  await queue('first plain',B);await queue('\u200b/compact',C);
  await finish();
  assert.deepEqual(submitted.map(x=>x.text),['active','first plain','\u200b/compact']);
  for(const uuid of [B,C])assert.equal(events.filter(e=>e.type==='message'&&e.message.uuid===uuid).length,1);
});
