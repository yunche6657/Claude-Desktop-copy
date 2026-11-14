import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {createSessionKernel} = createRequire(import.meta.url)('../desktop/session-kernel.cjs');

test('duplicate start reuses transcript and running turn', async t => {
  let finish;
  const kernel = createSessionKernel({emit(){}, createAgent:()=>({run:()=>new Promise(r=>{finish=r})})});
  t.after(()=>kernel.dispose());
  const id = 'local_duplicate';
  kernel.start({sessionId:id,cwd:'original'});
  kernel.setTranscript(id,[{message:{content:'kept'}}]);
  const lease = kernel.getSessionLease(id);
  const turn = kernel.sendMessage(id,'question');
  assert.equal(kernel.start({sessionId:id,cwd:'replacement'}).cwd,'original');
  const queued=kernel.start({sessionId:id,message:'duplicate'});
  assert.equal(kernel.getSession(id).cwd,'original');
  assert.equal(kernel.getTranscript(id)[0].message.content,'kept');
  assert.equal(lease.isCurrent(),false); // starting the turn changes session state
  finish({text:'answer',stopReason:'end_turn'});
  assert.equal((await turn).ok,true);
  assert.equal(kernel.getTranscript(id)[0].message.content,'kept');
  assert.equal((await queued).sessionId,id);
  finish({text:'second answer',stopReason:'end_turn'});
});

test('duplicate start delivers image-only input on the existing session and preserves history', async t => {
  let finish, received;
  const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},dispose(){},
    sendMessage(id,text,options){received={id,text,options};return new Promise(r=>{finish=r})}};
  const kernel=createSessionKernel({backend,emit(){}}); t.after(()=>kernel.dispose());
  const id='local_resume'; kernel.start({sessionId:id,cwd:'first'});
  kernel.setTranscript(id,[{message:{role:'user',content:'earlier'}}]);
  const images=[{base64:Buffer.from('image fixture').toString('base64'),mimeType:'image/png'}];
  const result=await kernel.start({sessionId:id,cwd:'ignored',images,messageUuid:'11111111-2222-4333-8444-555555555555'});
  assert.equal(result.sessionId,id); assert.equal(result.cwd,'first');
  assert.equal(received.text,''); assert.deepEqual(received.options.images,images);
  assert.equal(received.options.messages[0].content[0].text,'earlier');
  assert.equal(received.options.messages[0].content.at(-1).type,'image');
  assert.equal(received.options.messageUuid,'11111111-2222-4333-8444-555555555555');
  finish({text:'reply',stopReason:'end_turn'}); await new Promise(setImmediate);
  assert.equal(kernel.getTranscript(id)[0].message.content,'earlier');
  assert.equal(kernel.getTranscript(id).length,3);
});

test('duplicate start observes import gate and rejects malformed images before starting', async t => {
  let calls=0;
  const kernel=createSessionKernel({emit(){},createAgent:()=>({async run(){calls++;return {text:'ok'}}})});
  t.after(()=>kernel.dispose());
  const id='local_import'; kernel.start({sessionId:id}); kernel.update(id,{importedFrom:'terminalCli'});
  await assert.rejects(kernel.start({sessionId:id,message:'hello'}),{name:'ImportedResumeGateError'});
  assert.equal(kernel.confirmImportedSessionResume(id),true);
  await assert.rejects(kernel.start({sessionId:id,images:[{base64:'bad?',mimeType:'image/png'}]}),/Invalid image/);
  assert.equal(calls,0); assert.equal(kernel.getSession(id).isRunning,false);
  assert.deepEqual(kernel.getTranscript(id),[]);
});

test('queued duplicate start rechecks import gate before delivery', async t => {
  let release, calls=0;
  const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},dispose(){},
    setModel:()=>new Promise(r=>{release=r}),async sendMessage(){calls++;return {text:'ok'}}};
  const kernel=createSessionKernel({backend,emit(){}}); t.after(()=>kernel.dispose());
  const id='local_queued'; kernel.start({sessionId:id});
  const change=kernel.setModel(id,'pending');
  const result=kernel.start({sessionId:id,message:'queued'});
  kernel.update(id,{importedFrom:'terminalCli'});
  release(); await change;
  await assert.rejects(result,{name:'ImportedResumeGateError'});
  assert.equal(calls,0); assert.deepEqual(kernel.getTranscript(id),[]);
});

test('replacement during turn_started cannot deliver an old message to the new generation', async t => {
  let calls=0, kernel;
  const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},removeSession(){},dispose(){},
    async sendMessage(){calls++;return {text:'unexpected'}}};
  const id='local_reentrant';
  kernel=createSessionKernel({backend,emit:event=>{
    if(event.type==='turn_started'){kernel.remove(id);kernel.start({sessionId:id,cwd:'replacement'});}
  }}); t.after(()=>kernel.dispose());
  kernel.start({sessionId:id,cwd:'original'});
  await assert.rejects(kernel.start({sessionId:id,message:'old message'}),/cancelled/);
  assert.equal(calls,0); assert.equal(kernel.getSession(id).cwd,'replacement');
  assert.deepEqual(kernel.getTranscript(id),[]);
});

test('busy repeated starts wait in order and resolve only once each turn starts', async t => {
  const seen=[], finish=[];
  const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},dispose(){},
    sendMessage(_id,text){seen.push(text);return new Promise(r=>finish.push(r))}};
  const kernel=createSessionKernel({backend,emit(){}}); t.after(()=>kernel.dispose());
  const id='local_fifo'; kernel.start({sessionId:id});
  const active=kernel.sendMessage(id,'first');
  let accepted=false; const second=kernel.start({sessionId:id,message:'second'}).then(v=>{accepted=true;return v});
  const third=kernel.start({sessionId:id,message:'third'});
  await Promise.resolve(); assert.equal(accepted,false); assert.deepEqual(seen,['first']);
  finish[0]({text:'one'}); await active; await second;
  assert.deepEqual(seen,['first','second']);
  finish[1]({text:'two'}); await third;
  assert.deepEqual(seen,['first','second','third']);
  finish[2]({text:'three'});
});

test('deferred start queue is bounded and rejects waiting entries on delete or dispose', async t => {
  const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},removeSession(){},dispose(){},sendMessage(){return new Promise(()=>{})}};
  const kernel=createSessionKernel({backend,emit(){}}); t.after(()=>kernel.dispose());
  const id='local_bounded'; kernel.start({sessionId:id}); kernel.sendMessage(id,'active');
  const pending=Array.from({length:32},(_,i)=>kernel.start({sessionId:id,message:`wait ${i}`}));
  const rejected=Promise.all(pending.map(p=>assert.rejects(p,/session deleted/)));
  await assert.rejects(kernel.start({sessionId:id,message:'overflow'}),/queue is full/);
  kernel.remove(id); await rejected;
  kernel.start({sessionId:id}); kernel.sendMessage(id,'active again');
  const waiting=assert.rejects(kernel.start({sessionId:id,message:'waiting'}),/disposed/);
  kernel.dispose(); await waiting;
});

test('host FIFO can cancel and reorder only unsubmitted UUIDs', async t => {
  const seen=[],finish=[];
  const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},removeSession(){},dispose(){},
    sendMessage(_id,text){seen.push(text);return new Promise(r=>finish.push(r))}};
  const kernel=createSessionKernel({backend,emit(){}});t.after(()=>kernel.dispose());
  const id='local_controls',ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
  kernel.start({sessionId:id});const active=kernel.sendMessage(id,'active',{messageUuid:ids[0]});
  const a=kernel.start({sessionId:id,message:'a',messageUuid:ids[1]});
  const b=kernel.start({sessionId:id,message:'b',messageUuid:ids[2]});
  const c=kernel.start({sessionId:id,message:'c',messageUuid:ids[3]});
  const cancelled=assert.rejects(b,{name:'QueuedMessageCancelledError'});
  await assert.rejects(kernel.start({sessionId:id,message:'collision',messageUuid:ids[0]}),/already pending/);
  await assert.rejects(kernel.start({sessionId:id,message:'collision',messageUuid:ids[1]}),/already pending/);
  assert.equal(kernel.reorderQueuedMessage(id,ids[3],ids[1]),true);
  assert.deepEqual(kernel.getQueuedMessages(id).map(x=>x.uuid),[ids[3],ids[1],ids[2]]);
  assert.equal(kernel.cancelQueuedMessage(id,ids[2]),true);await cancelled;
  assert.equal(kernel.cancelQueuedMessage(id,ids[2]),false);
  assert.equal(kernel.cancelQueuedMessage(id,ids[0]),false);
  assert.equal(kernel.reorderQueuedMessage(id,ids[1],ids[1]),false);
  finish[0]({text:'first'});await active;await c;
  assert.deepEqual(seen,['active','c']);assert.equal(kernel.cancelQueuedMessage(id,ids[3]),false);
  finish[1]({text:'second'});await a;assert.deepEqual(seen,['active','c','a']);
  finish[2]({text:'third'});
});

test('host FIFO controls fail closed after deletion and replacement', async t => {
  const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},removeSession(){},dispose(){},sendMessage(){return new Promise(()=>{})}};
  const kernel=createSessionKernel({backend,emit(){}});t.after(()=>kernel.dispose());
  const id='local_deleted',uuid='11111111-1111-4111-8111-111111111111';kernel.start({sessionId:id});kernel.sendMessage(id,'first');
  const pending=assert.rejects(kernel.start({sessionId:id,message:'queued',messageUuid:uuid}),/session deleted/);
  kernel.remove(id);kernel.start({sessionId:id});await pending;
  assert.deepEqual(kernel.getQueuedMessages(id),[]);
  assert.equal(kernel.cancelQueuedMessage(id,uuid),false);
  assert.equal(kernel.reorderQueuedMessage(id,uuid,uuid),false);
});

test('host FIFO reorder matches the fixed native deferred queue in all three-item moves', t => {
  const sourcePath=new URL('../../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js',import.meta.url);
  if(!fs.existsSync(sourcePath)){t.skip('fixed reference unavailable');return}
  const source=fs.readFileSync(sourcePath,'utf8');
  const start=source.indexOf('reorderQueuedMessage(e,n,r){'),end=source.indexOf('sendHeldMessageNow(e,t){',start);
  assert.ok(start>=0&&end>start);
  const method=vm.runInNewContext(`({${source.slice(start,end)}})`,{t:{L5:{warn(){},info(){}}}}).reorderQueuedMessage;
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
  for(const from of ids)for(const over of ids){
    const native={query:{},deferredSends:ids.map(uuid=>({msg:{uuid}})),messageBuffer:ids.map(uuid=>({uuid}))};
    const expected=method.call({deps:{getSession:()=>native,persistWaitingInput(){},emitSessionUpdated(){}}},'s',from,over);
    const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},removeSession(){},dispose(){},sendMessage(){return new Promise(()=>{})}};
    const kernel=createSessionKernel({backend,emit(){}});kernel.start({sessionId:'s'});kernel.sendMessage('s','hold');
    for(const uuid of ids)kernel.start({sessionId:'s',message:'queued',messageUuid:uuid}).catch(()=>{});
    assert.equal(kernel.reorderQueuedMessage('s',from,over),expected);
    assert.deepEqual(kernel.getQueuedMessages('s').map(x=>x.uuid),native.deferredSends.map(x=>x.msg.uuid));
    kernel.remove('s');kernel.dispose();
  }
});

test('lease is detached and expires on update, remove, recreate and disposal', t => {
  const kernel=createSessionKernel({emit(){},createAgent:()=>({})});
  t.after(()=>kernel.dispose());
  const id='local_lease'; kernel.start({sessionId:id,cwd:'first'});
  let lease=kernel.getSessionLease(id);
  lease.session.cwd='tampered';
  assert.equal(kernel.getSession(id).cwd,'first');
  assert.equal(lease.isCurrent(),true);
  kernel.setTranscript(id,[]); assert.equal(lease.isCurrent(),false);
  lease=kernel.getSessionLease(id);
  kernel.update(id,{title:'change'}); assert.equal(lease.isCurrent(),false);
  lease=kernel.getSessionLease(id); kernel.remove(id); kernel.start({sessionId:id,cwd:'second'});
  assert.equal(lease.isCurrent(),false);
  lease=kernel.getSessionLease(id); kernel.dispose(); assert.equal(lease.isCurrent(),false);
  assert.equal(kernel.getSessionLease(id),null);
});

test('a removed generation cannot block a recreated session behind a pending model change', async t => {
  let release;
  const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},removeSession(){},dispose(){},setModel:()=>new Promise(r=>{release=r}),sendMessage:async()=>({text:'new answer',stopReason:'end_turn'})};
  const kernel=createSessionKernel({backend,emit(){}}); t.after(()=>kernel.dispose());
  const id='local_queue'; kernel.start({sessionId:id});
  const old=kernel.setModel(id,'slow');
  kernel.remove(id); kernel.start({sessionId:id});
  const result=await kernel.sendMessage(id,'new');
  assert.equal(result.ok,true);
  release(); assert.equal(await old,null);
  assert.notEqual(kernel.getSession(id).model,'slow');
});

test('an old warm completion does not clear a recreated session warm marker', async t => {
  const releases=[];
  const backend={id:'stub',start(){},cancel(){},onEvent(){return ()=>{}},removeSession(){},dispose(){},sendMessage:async()=>({}),
    warm:()=>new Promise(resolve=>releases.push(resolve))};
  const kernel=createSessionKernel({backend,emit(){}}); t.after(()=>kernel.dispose());
  const id='local_warm'; kernel.start({sessionId:id});
  const old=kernel.warmSession(id);
  kernel.remove(id); kernel.start({sessionId:id});
  const current=kernel.warmSession(id);
  releases[0](); await old;
  assert.equal(kernel.getWarmLifecycleState(id).warming,true);
  releases[1](); await current;
  assert.equal(kernel.getWarmLifecycleState(id).warming,false);
});

test('optional CLI input observation matches session, actor and exact active UUID without exposing payload', async t => {
  const listeners=new Set(),events=[];let actor='actor-1', finish;
  const backend={id:'ccb',start(){},cancel(){},dispose(){},getInfo(){return {actorToken:actor}},
    onEvent(fn){listeners.add(fn);return ()=>listeners.delete(fn)},sendMessage(){return new Promise(r=>{finish=r})}};
  const kernel=createSessionKernel({backend,trackCliInputObservations:true,emit:e=>events.push(e)});t.after(()=>kernel.dispose());
  const id='local_observed',uuid='11111111-2222-4333-8444-555555555555';kernel.start({sessionId:id});
  const turn=kernel.sendMessage(id,'private fixture',{messageUuid:uuid});
  const send=e=>{for(const fn of listeners)fn(e)};
  send({type:'user_input_observed',sessionId:id,messageUuid:uuid,actorToken:'other'});
  send({type:'user_input_observed',sessionId:'another',messageUuid:uuid,actorToken:actor});
  send({type:'user_input_observed',sessionId:id,messageUuid:'wrong',actorToken:actor});
  assert.equal(kernel.getCliInputObservation(id),null);
  send({type:'user_input_observed',sessionId:id,messageUuid:uuid,actorToken:actor});
  assert.deepEqual(kernel.getCliInputObservation(id),{messageUuid:uuid,status:'cli_observed'});
  assert.equal(events.some(e=>e.type==='user_input_observed'),false);
  actor='actor-2';assert.equal(kernel.getCliInputObservation(id),null);actor='actor-1';
  finish({text:'reply'});await turn;
  assert.equal(kernel.getTranscript(id).filter(row=>row.type==='user').length,1);
  kernel.remove(id);assert.equal(kernel.getCliInputObservation(id),null);
});

test('CLI observations are disabled by default and ignored after cancel', async t => {
  for(const enabled of [false,true]) {
    const listeners=new Set();let finish;
    const backend={id:'ccb',start(){},cancel(){},dispose(){},getInfo(){return {actorToken:'actor'}},
      onEvent(fn){listeners.add(fn);return ()=>listeners.delete(fn)},sendMessage(){return new Promise(r=>{finish=r})}};
    const kernel=createSessionKernel({backend,trackCliInputObservations:enabled,emit(){}});t.after(()=>kernel.dispose());
    const id=`local_observation_${enabled}`,uuid='11111111-2222-4333-8444-555555555555';kernel.start({sessionId:id});
    const turn=kernel.sendMessage(id,'fixture',{messageUuid:uuid});
    const send=()=>{for(const fn of listeners)fn({type:'user_input_observed',sessionId:id,messageUuid:uuid,actorToken:'actor'})};
    if(!enabled){send();assert.equal(kernel.getCliInputObservation(id),null)}
    kernel.cancel(id);send();assert.equal(kernel.getCliInputObservation(id),null);
    finish({text:'late'});await turn;
  }
});
