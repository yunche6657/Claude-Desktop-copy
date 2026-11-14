import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createMcpControlGate}=createRequire(import.meta.url)('../desktop/mcp-control-gate.cjs');
test('one actor/server control remains locked until actual completion, and stale actors cannot commit',async()=>{
 let actor='a',finish;const calls=[];
 const gate=createMcpControlGate({isCurrent:(_id,token)=>actor===token});
 const pending=gate.run('s','a','x',()=>{calls.push('first');return new Promise(r=>finish=r)});
 await assert.rejects(gate.run('s','a','x',()=>calls.push('overlap')),/in progress/);
 assert.equal(await gate.run('s','a','y',()=>42),42);
 actor='b';finish('old');await assert.rejects(pending,/Session not running/);
 assert.equal(await gate.run('s','b','x',()=>42),42);assert.deepEqual(calls,['first']);
});
test('CCB control timeout poisons the lane until actor replacement or retirement',async()=>{
 let actor='a';const gate=createMcpControlGate({isCurrent:(_id,token)=>actor===token});
 const timeout=Object.assign(new Error('timeout'),{code:'CCB_CONTROL_TIMEOUT'});
 await assert.rejects(gate.run('s','a','x',async()=>{throw timeout}),/timeout/);
 await assert.rejects(gate.run('s','a','x',()=>42),/state unknown/);
 assert.equal(await gate.run('s','a','y',()=>42),42);
 actor='b';assert.equal(await gate.run('s','b','x',()=>42),42);
 gate.retireSession('s');actor='a';assert.equal(await gate.run('s','a','x',()=>42),42);
});
