import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createMcpConfigEpochs}=createRequire(import.meta.url)('../desktop/mcp-config-epochs.cjs');
const {createSessionKernel}=createRequire(import.meta.url)('../desktop/session-kernel.cjs');

test('config epochs survive status-only changes and never resurrect after config changes',()=>{
 const epochs=createMcpConfigEpochs(), row={name:'x',status:'failed',scope:'project',config:{type:'http',url:'https://example.test/a',headers:{token:'fixture'}}};
 epochs.update([row]);const first=epochs.get('x');assert.ok(first);
 epochs.update([{...row,status:'connected'}]);assert.equal(epochs.get('x'),first);
 epochs.update([{...row,config:{...row.config,url:'https://example.test/b'}}]);assert.notEqual(epochs.get('x'),first);
 epochs.update([row]);assert.notEqual(epochs.get('x'),first);
 const before=epochs.get('x');epochs.update([row,row]);assert.equal(epochs.get('x'),undefined);
 epochs.update([row]);assert.notEqual(epochs.get('x'),before);
 epochs.update([]);assert.equal(epochs.get('x'),undefined);
});

test('session epochs are bound to the actor and successful observed status',async t=>{
 let actor='a',url='https://example.test/a', fail=false;
 const backend={id:'ccb',start(){},cancel(){},dispose(){},onEvent(){return()=>{}},async sendMessage(){},getInfo(){return {actorToken:actor}},
  async mcpServerStatus(_id,token){if(fail)throw Error('poll failed');return {actorToken:token,servers:[{name:'srv',status:'connected',scope:'project',config:{type:'http',url}}]}}};
 const kernel=createSessionKernel({backend,emit(){}});t.after(()=>kernel.dispose());kernel.start({sessionId:'s'});
 await kernel.refreshCliMcpStatus('s');const first=kernel.getCliMcpConfigEpoch('s','a','srv');assert.ok(first);
 fail=true;assert.equal(await kernel.refreshCliMcpStatus('s'),false);assert.equal(kernel.getCliMcpConfigEpoch('s','a','srv'),first);
 fail=false;url='https://example.test/b';await kernel.refreshCliMcpStatus('s');assert.notEqual(kernel.getCliMcpConfigEpoch('s','a','srv'),first);
 url='https://example.test/a';await kernel.refreshCliMcpStatus('s');assert.notEqual(kernel.getCliMcpConfigEpoch('s','a','srv'),first);
 actor='b';assert.equal(kernel.getCliMcpConfigEpoch('s','a','srv'),undefined);
});
