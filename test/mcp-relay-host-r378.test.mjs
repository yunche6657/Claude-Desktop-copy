import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const {createMcpRelayHost}=createRequire(import.meta.url)('../desktop/mcp-relay-host.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture() {
 const ci=new PassThrough(),co=new PassThrough(),si=new PassThrough(),so=new PassThrough(), ctrl=new AbortController();
 const requests=[];let buf='',current=true,permission=true,conflict=false,cleanups=0;const statuses=[];
 si.on('data',chunk=>{buf+=chunk;let p;while((p=buf.indexOf('\n'))>=0){requests.push(JSON.parse(buf.slice(0,p)));buf=buf.slice(p+1)}});
 const host=createMcpRelayHost({isCurrent:()=>current,authorize:()=>permission,onStatus:s=>statuses.push(s.state)});
 const source={name:'fixture',kind:'project',conflicts:()=>conflict},actor={},connection={};
 const args={session:'session',actor,connection,source,signal:ctrl.signal,clientInput:ci,clientOutput:co,serverInput:si,serverOutput:so,closeTransport:()=>cleanups++};
 const binding=host.attach(args);
 const send=(s,v)=>s.write(JSON.stringify(v)+'\n');
 async function declare(uri='ui://fixture/page') {send(ci,{jsonrpc:'2.0',id:'list',method:'tools/list'});await tick();const q=requests.at(-1);send(so,{jsonrpc:'2.0',id:q.id,result:{tools:[{name:'view',_meta:{ui:{resourceUri:uri}}}]}});await tick()}
 return {host,binding,args,ci,co,si,so,ctrl,requests,statuses,declare,send,setCurrent:v=>current=v,setPermission:v=>permission=v,setConflict:v=>conflict=v,get cleanups(){return cleanups}};
}
test('resource reads bind actor and connection to filtered declarations and current authority',async()=>{
 const f=fixture();await f.declare();assert.deepEqual(f.host.getStatus(f.binding).declaredUris,['ui://fixture/page']);
 await assert.rejects(f.host.read({...f.binding,actor:{}},'ui://fixture/page'),/binding mismatch/);
 await assert.rejects(f.host.read(f.binding,'ui://other'),/not declared/);
 f.setPermission(false);await assert.rejects(f.host.read(f.binding,'ui://fixture/page'),/denied/);f.setPermission(true);
 const p=f.host.read(f.binding,'ui://fixture/page');await tick();const q=f.requests.at(-1);assert.equal(q.method,'resources/read');
 f.send(f.so,{jsonrpc:'2.0',id:q.id,result:{contents:[{uri:'ui://fixture/page',text:'ok'}]}});assert.equal((await p).contents[0].text,'ok');
 f.setCurrent(false);assert.throws(()=>f.host.getStatus(f.binding),/stale/);assert.equal(f.cleanups,1);assert.deepEqual(f.statuses,['connected','ready','closed']);
});
test('replacement declarations revoke inflight reads and abort closes exactly once',async()=>{
 const f=fixture();await f.declare();const p=f.host.read(f.binding,'ui://fixture/page');await tick();const q=f.requests.at(-1);await f.declare('ui://new');
 f.send(f.so,{jsonrpc:'2.0',id:q.id,result:{contents:[{uri:'ui://fixture/page'}]}});await assert.rejects(p,/declaration changed/);
 const pending=f.host.read(f.binding,'ui://new');await tick();f.ctrl.abort();await assert.rejects(pending,/binding invalidated|stale/);f.host.dispose();assert.equal(f.cleanups,1);
});
test('duplicate identities rejected, malformed/conflicting declarations removed and disconnect invalidates',async()=>{
 const f=fixture();assert.throws(()=>f.host.attach({...f.args,connection:{}}),/already attached/);
 await f.declare('https://invalid');assert.deepEqual(f.host.getStatus(f.binding).declaredUris,[]);
 f.setConflict(true);await f.declare();assert.deepEqual(f.host.getStatus(f.binding).declaredUris,[]);
 f.so.end();await tick();assert.throws(()=>f.host.getStatus(f.binding),/binding mismatch/);assert.equal(f.cleanups,1);
});
test('abort propagates cancellation and rejects mismatched response contents',async()=>{
 const f=fixture();await f.declare();const ac=new AbortController();const p=f.host.read(f.binding,'ui://fixture/page',{signal:ac.signal});await tick();ac.abort();await assert.rejects(p,/aborted/);assert.equal(f.requests.at(-1).method,'notifications/cancelled');
 const q=f.host.read(f.binding,'ui://fixture/page');await tick();f.send(f.so,{jsonrpc:'2.0',id:f.requests.at(-1).id,result:{contents:[{uri:'ui://wrong'}]}});await assert.rejects(q,/invalid resource response/);f.host.dispose();
});
test('permission revocation while read is pending suppresses returned data',async()=>{
 const f=fixture();await f.declare();const p=f.host.read(f.binding,'ui://fixture/page');await tick();const q=f.requests.at(-1);f.setPermission(false);
 f.send(f.so,{jsonrpc:'2.0',id:q.id,result:{contents:[{uri:'ui://fixture/page',text:'secret'}]}});await assert.rejects(p,/denied/);f.host.dispose();
});
test('list changed revokes and concurrent list replies cannot restore old declarations',async()=>{
 const f=fixture();await f.declare();f.send(f.so,{jsonrpc:'2.0',method:'notifications/tools/list_changed'});await tick();assert.deepEqual(f.host.getStatus(f.binding).declaredUris,[]);
 f.send(f.ci,{jsonrpc:'2.0',id:'a',method:'tools/list'});f.send(f.ci,{jsonrpc:'2.0',id:'b',method:'tools/list'});await tick();const [a,b]=f.requests.slice(-2);
 f.send(f.so,{jsonrpc:'2.0',id:b.id,result:{tools:[{name:'new',_meta:{ui:{resourceUri:'ui://new'}}}]}});
 f.send(f.so,{jsonrpc:'2.0',id:a.id,result:{tools:[{name:'old',_meta:{ui:{resourceUri:'ui://old'}}}]}});await tick();assert.deepEqual(f.host.getStatus(f.binding).declaredUris,[]);
 await f.declare('ui://fresh');assert.deepEqual(f.host.getStatus(f.binding).declaredUris,['ui://fresh']);f.host.dispose();
});
test('source identity is snapshotted rather than mutable by caller',async()=>{
 const f=fixture();f.args.source.name='other';f.args.source.kind='invalid';await f.declare();assert.deepEqual(f.host.getStatus(f.binding).declaredUris,['ui://fixture/page']);f.host.dispose();
});
test('same-chunk list change revokes a completed response; cancelled overlap recovers on fresh list',async()=>{
 const f=fixture();f.send(f.ci,{jsonrpc:'2.0',id:'a',method:'tools/list'});await tick();const a=f.requests.at(-1);
 f.so.write(JSON.stringify({jsonrpc:'2.0',id:a.id,result:{tools:[{name:'x',_meta:{ui:{resourceUri:'ui://x'}}}]}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\n');await tick();assert.deepEqual(f.host.getStatus(f.binding).declaredUris,[]);
 f.send(f.ci,{jsonrpc:'2.0',id:'b',method:'tools/list'});f.send(f.ci,{jsonrpc:'2.0',id:'c',method:'tools/list'});await tick();const [b,c]=f.requests.slice(-2);
 f.send(f.ci,{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'b'}});f.send(f.so,{jsonrpc:'2.0',id:c.id,result:{tools:[{name:'c',_meta:{ui:{resourceUri:'ui://c'}}}]}});await tick();assert.deepEqual(f.host.getStatus(f.binding).declaredUris,[]);
 f.send(f.so,{jsonrpc:'2.0',id:b.id,result:{tools:[{name:'b',_meta:{ui:{resourceUri:'ui://b'}}}]}});await tick();await f.declare('ui://fresh');assert.deepEqual(f.host.getStatus(f.binding).declaredUris,['ui://fresh']);f.host.dispose();
});
