import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const {patchCoworkMessages}=createRequire(import.meta.url)('../desktop/cowork-message-patch.cjs');
test('Cowork updates a durable assistant row when the same UUID gains final text',()=>{
 const source='function receive(n){if(n.uuid){if(Hi.current.has(n.uuid))return;Hi.current.add(n.uuid)}let t=Date.now();Ae(e=>[...e,{...n,receivedStreamAt:t}]);} function closeFixture(){switch("close"){case"close":Ys(t),void 0;}} async function registerFixture(){await xa(i,()=>{e===0&&m.stamp("mcp_first_client"),e+=1})}';
 const patched=patchCoworkMessages(source);assert.ok(patched?.changed);
 let rows=[];const context={Hi:{current:new Set()},Ae:update=>{rows=update(rows)}};
 vm.createContext(context);vm.runInContext(patched.text,context);
 context.receive({uuid:'a',type:'assistant',message:{content:[{type:'thinking',thinking:'progress'}]}});
 context.receive({uuid:'a',type:'assistant',message:{content:[{type:'thinking',thinking:'progress'},{type:'text',text:'complete answer'}]}});
 assert.equal(rows.length,1);assert.equal(rows[0].message.content[1].text,'complete answer');
 context.receive({uuid:'a',type:'assistant',message:{content:rows[0].message.content}});
 assert.equal(rows.length,1);
 context.receive({uuid:'late-user',type:'user',timestamp:'2026-11-12T10:00:00Z',message:{content:[]}});
 context.receive({uuid:'later-assistant',type:'assistant',timestamp:'2026-11-12T10:00:02Z',message:{content:[]}});
 context.receive({uuid:'earlier-user',type:'user',timestamp:'2026-11-12T09:59:00Z',message:{content:[]}});
 assert.ok(rows.findIndex(x=>x.uuid==='earlier-user')<rows.findIndex(x=>x.uuid==='later-assistant'));
});
test('pending MCP registration does not hold transcript initialization',async()=>{
 const source='function receive(n){if(n.uuid){if(Hi.current.has(n.uuid))return;Hi.current.add(n.uuid)}let t=0;Ae(e=>[...e,{...n,receivedStreamAt:t}]);} async function load(){let e=0;await xa(i,()=>{e===0&&m.stamp("mcp_first_client"),e+=1});return "history-ready";}';
 const patched=patchCoworkMessages(source);assert.ok(patched);
 const context={xa:()=>new Promise(()=>{}),i:[],m:{stamp(){}},Hi:{current:new Set()},Ae(){}};
 vm.createContext(context);vm.runInContext(patched.text,context);
 assert.equal(await context.load(),'history-ready');
});
