import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const {createSessionKernel}=createRequire(import.meta.url)('../desktop/session-kernel.cjs');
const source=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const hje=source.slice(source.indexOf('function HJe('),source.indexOf('function UJe(',source.indexOf('function HJe(')));
const gate=source.slice(source.indexOf('var Xd="This session was imported."'),source.indexOf('function RXe(',source.indexOf('var Xd="This session was imported."')));
const native=vm.runInNewContext(`${hje}\n${gate}\nLXe`);

test('cold imported sends use native gate message and allow a confirmed session', async t=>{
 let calls=0; const events=[];
 const backend={id:'fixture',start(){},cancel(){},onEvent(){return ()=>{}},dispose(){},async sendMessage(){calls++;return {}}};
 const kernel=createSessionKernel({backend,emit:e=>events.push(e)}); t.after(()=>kernel.dispose());
 for (const origin of ['terminalCli','previous-profile-code']) {
  const id=kernel.start({cwd:process.cwd()}).sessionId;
  kernel.update(id,{importedFrom:origin});
  const expected=native({importedFrom:origin});
  await assert.rejects(kernel.sendMessage(id,'hello'), e=>e.name===expected.name && e.message===expected.message);
  const denied=await kernel.sendMessage(id,'hello',{origin:{kind:'agent'}});
  assert.equal(denied.delivered,false); assert.equal(denied.reason,expected.message); assert.equal(denied.cause.name,expected.name);
  assert.equal(kernel.getTranscript(id).length,0); assert.equal(calls,0);
  assert.equal(kernel.confirmImportedSessionResume(id),true);
  await kernel.sendMessage(id,'hello'); assert.equal(calls,1); calls=0;
 }
});

