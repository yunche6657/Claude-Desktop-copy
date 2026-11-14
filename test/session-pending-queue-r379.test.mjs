import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createSessionKernel}=createRequire(import.meta.url)('../desktop/session-kernel.cjs');
const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];

function harness(t){
  let releaseModel;const seen=[];
  const backend={id:'stub',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},
    setModel(){return new Promise(resolve=>{releaseModel=resolve})},
    async sendMessage(_id,text){seen.push(text);return{text:'reply'}}};
  const kernel=createSessionKernel({backend,emit(){}});t.after(()=>kernel.dispose());
  const id='local_waiting_model';kernel.start({sessionId:id});
  const model=kernel.setModel(id,'next-model');
  return {kernel,id,seen,model,release:()=>releaseModel()};
}

test('queued UUID remains cancellable while waiting for a model change before backend submission',async t=>{
  const {kernel,id,seen,model,release}=harness(t);
  const pending=kernel.start({sessionId:id,message:'withdrawn',messageUuid:ids[0]});
  const cancelled=assert.rejects(pending,{name:'QueuedMessageCancelledError'});
  assert.deepEqual(seen,[]);
  assert.deepEqual(kernel.getQueuedMessages(id),[{uuid:ids[0]}]);
  assert.equal(kernel.cancelQueuedMessage(id,ids[0]),true);
  assert.equal(kernel.cancelQueuedMessage(id,ids[0]),false);
  await cancelled;
  assert.deepEqual(kernel.getQueuedMessages(id),[]);
  release();await model;await new Promise(setImmediate);
  assert.deepEqual(seen,[]);assert.deepEqual(kernel.getTranscript(id),[]);
  assert.equal(kernel.getSession(id).isRunning,false);
  assert.equal((await kernel.sendMessage(id,'subsequent')).ok,true);
  assert.deepEqual(seen,['subsequent']);
});

test('cancelling admitted input preserves the next FIFO entry and excludes both cancelled payloads',async t=>{
  const {kernel,id,seen,model,release}=harness(t);
  const first=kernel.start({sessionId:id,message:'first-cancelled',messageUuid:ids[0]});
  const second=kernel.start({sessionId:id,message:'survivor',messageUuid:ids[1]});
  const third=kernel.start({sessionId:id,message:'third-cancelled',messageUuid:ids[2]});
  const firstCancelled=assert.rejects(first,{name:'QueuedMessageCancelledError'});
  const thirdCancelled=assert.rejects(third,{name:'QueuedMessageCancelledError'});
  assert.equal(kernel.cancelQueuedMessage(id,ids[0]),true);await firstCancelled;
  await new Promise(setImmediate);
  assert.deepEqual(kernel.getQueuedMessages(id),[{uuid:ids[1]},{uuid:ids[2]}]);
  assert.equal(kernel.cancelQueuedMessage(id,ids[2]),true);await thirdCancelled;
  assert.deepEqual(kernel.getQueuedMessages(id),[{uuid:ids[1]}]);assert.deepEqual(seen,[]);
  release();await model;assert.equal((await second).sessionId,id);await new Promise(setImmediate);
  assert.deepEqual(seen,['survivor']);assert.deepEqual(kernel.getQueuedMessages(id),[]);
});

test('direct send waiting for a model change rejects cancellation before it can enter the backend',async t=>{
  const {kernel,id,seen,model,release}=harness(t);
  const pending=kernel.sendMessage(id,'direct-cancelled',{messageUuid:ids[0]});
  const cancelled=assert.rejects(pending,{name:'QueuedMessageCancelledError'});
  assert.equal(kernel.cancelQueuedMessage(id,ids[1]),false);
  assert.equal(kernel.cancelQueuedMessage(id,ids[0]),true);await cancelled;
  release();await model;await new Promise(setImmediate);assert.deepEqual(seen,[]);
});

test('disposal settles admitted and deferred message waiters before a stalled model change completes',async t=>{
 const {kernel,id,seen,model,release}=harness(t),outcomes=[];
 const admitted=kernel.start({sessionId:id,message:'admitted',messageUuid:ids[0]}).then(()=>outcomes.push('admitted-sent'),error=>outcomes.push(error.message));
 const deferred=kernel.start({sessionId:id,message:'deferred',messageUuid:ids[1]}).then(()=>outcomes.push('deferred-sent'),error=>outcomes.push(error.message));
 kernel.dispose();await new Promise(setImmediate);
 assert.deepEqual(outcomes.sort(),['session kernel disposed','session kernel disposed']);
 assert.deepEqual(kernel.getQueuedMessages(id),[]);assert.deepEqual(seen,[]);
 release();await model;await Promise.all([admitted,deferred]);await new Promise(setImmediate);
 assert.deepEqual(seen,[]);
});

test('disposal reentered from turn_started prevents backend submission and clears running state',async t=>{
 let kernel,calls=0;
 const backend={id:'stub',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},async sendMessage(){calls++;return{text:'unexpected'}}};
 kernel=createSessionKernel({backend,emit:event=>{if(event.type==='turn_started')kernel.dispose()}});t.after(()=>kernel.dispose());
 const id='local_reentrant_dispose';kernel.start({sessionId:id});
 await assert.rejects(kernel.start({sessionId:id,message:'never submit'}),/disposed/);
 assert.equal(calls,0);assert.equal(kernel.getSession(id).isRunning,false);
 assert.deepEqual(kernel.getQueuedMessages(id),[]);assert.deepEqual(kernel.getTranscript(id),[]);
});

test('disposed kernel refuses fresh starts, sends and model changes without adding work',async t=>{
 const {kernel,id,seen,model,release}=harness(t);kernel.dispose();
 await assert.rejects(kernel.start({sessionId:'new-after-dispose'}),/disposed/);
 await assert.rejects(kernel.start({sessionId:id,message:'after dispose'}),/disposed/);
 await assert.rejects(kernel.sendMessage(id,'after dispose'),/disposed/);
 await assert.rejects(kernel.setModel(id,'after-dispose-model'),/disposed/);
 assert.equal(kernel.getSession('new-after-dispose'),null);assert.deepEqual(kernel.getQueuedMessages(id),[]);
 release();await model;assert.deepEqual(seen,[]);
});

test('missing or invalid UUID cannot cancel a nonexistent or admitted message',async t=>{
 const {kernel,id,seen,model,release}=harness(t);
 assert.equal(kernel.cancelQueuedMessage('missing'),false);
 assert.equal(kernel.cancelQueuedMessage(id),false);
 const pending=kernel.start({sessionId:id,message:'valid',messageUuid:ids[0]});
 for(const uuid of [undefined,null,'',123,{}])assert.equal(kernel.cancelQueuedMessage(id,uuid),false);
 release();await model;await pending;await new Promise(setImmediate);
 assert.deepEqual(seen,['valid']);
});
