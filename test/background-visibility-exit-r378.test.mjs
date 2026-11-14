import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const {waitForProcessExit}=createRequire(import.meta.url)('../desktop/background-visibility-check.cjs');
function fixture(probe){let t=0,calls=0;return {args:{timeoutMs:5000,intervalMs:100,now:()=>t,wait:async ms=>{t+=ms},probe:(...args)=>{calls++;return probe(t,...args)}},time:()=>t,calls:()=>calls};}
test('delayed OS exit is accepted only after ESRCH',async()=>{const f=fixture(t=>{if(t>=300)throw Object.assign(new Error('gone'),{code:'ESRCH'})});assert.equal(await waitForProcessExit(123,f.args),true);assert.equal(f.time(),300);});
test('persistently live process fails at bounded deadline',async()=>{const f=fixture(()=>{});assert.equal(await waitForProcessExit(123,f.args),false);assert.equal(f.time(),5000);assert.equal(f.calls(),51);});
test('permission and unknown probe errors do not count as process exit',async()=>{for(const code of ['EPERM','EACCES','unexpected']){const f=fixture(()=>{throw Object.assign(new Error('not proof of absence'),{code})});assert.equal(await waitForProcessExit(123,f.args),false);assert.equal(f.time(),5000);}});
