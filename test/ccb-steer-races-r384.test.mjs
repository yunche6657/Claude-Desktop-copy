import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createSteerQueue}=createRequire(import.meta.url)('../desktop/ccb-steer-queue.cjs');
function fixture(t){
  const signal=Promise.withResolvers(),calls=[],writes=[],events=[];
  const state={owned:true,open:true};
  const queue=createSteerQueue({owned:()=>state.owned,canWrite:()=>state.open,
    write:frame=>{writes.push(frame);return true},
    cancel:uuid=>{calls.push(uuid);return signal.promise},
    announce:event=>events.push(event),changed(){}});
  t.after(()=>queue.dispose());
  const frame={uuid:'B',type:'user',priority:'next',message:{role:'user',content:'keep exact text'}};
  return {queue,signal,calls,writes,events,state,frame};
}
for(const mode of ['success','denied','timeout','empty','withdraw','deleted','new actor','echo during cancel','window reopened']){
  test('in-flight CLI removal: '+mode,async t=>{
    const {queue,signal,calls,writes,events,state,frame}=fixture(t);
    assert.equal(queue.accept(frame,false),true);
    const first=queue.escalate('B');
    assert.equal(await queue.escalate('B'),false);
    assert.equal(await queue.escalate('unknown'),false);
    let withdrawn;
    if(mode==='withdraw')withdrawn=queue.withdraw('B');
    if(mode==='echo during cancel')queue.observe('B');
    if(mode==='deleted'||mode==='new actor'){state.owned=false;queue.dispose();}
    if(mode==='window reopened')state.open=false;
    if(mode==='timeout')signal.reject(Error('timeout'));
    else signal.resolve(mode==='empty'?{}:{cancelled:mode!=='denied'});
    const changed=mode==='success'||mode==='window reopened';
    assert.equal(await first,changed);
    if(withdrawn)assert.equal(await withdrawn,true);
    assert.deepEqual(calls,['B']);
    const rekeys=events.filter(e=>e.type==='steers_rekeyed');
    assert.equal(rekeys.length,Number(changed));
    const replacement=rekeys[0]?.rekeyedSteers[0].to;
    if(changed)assert.notEqual(replacement,'B');
    assert.deepEqual(writes.map(f=>[f.uuid,f.priority]),mode==='success'?[['B','next'],[replacement,'now']]:[['B','next']]);
    assert.equal(events.filter(e=>e.type==='steer_escalating').length,Number(mode==='success'));
    assert.equal(events.filter(e=>e.type==='steer_parked').length,Number(mode==='window reopened'));
    if(mode==='window reopened'){
      const parked=events.find(e=>e.type==='steer_parked').frame;
      assert.equal(parked.uuid,replacement);assert.equal(parked.priority,undefined);assert.deepEqual(parked.message,frame.message);
    }
  });
}

test('held escalation sends once under the original key and can only be retired by its own echo',t=>{
  const {queue,calls,writes,events,frame}=fixture(t);
  assert.equal(queue.accept(frame,true),true);assert.equal(writes.length,0);
  assert.equal(queue.escalate('B'),true);assert.equal(queue.escalate('B'),false);
  queue.observe('unrelated');assert.equal(queue.busy,true);
  queue.observe('B');queue.observe('B');assert.equal(queue.busy,false);
  assert.deepEqual(calls,[]);assert.deepEqual(writes.map(f=>[f.uuid,f.priority]),[['B','now']]);
  assert.deepEqual(events.map(e=>e.type),['steer_accepted','steer_escalating','steer_observed']);
});
