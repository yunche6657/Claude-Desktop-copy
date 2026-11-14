import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import vm from 'node:vm';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);const {createBootstrapConsent}=require('../desktop/hybrid-bootstrap-consent.cjs');
const source=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-xoZNrP6a.js',import.meta.url),'utf8');
const o=source.slice(source.indexOf('function o(e)'),source.indexOf('function s(e)'));const f=source.slice(source.indexOf('function f(t,n)'),source.indexOf('function p(t,n,r)'));assert.ok(o&&f);
function native(targets,store,fail=false){const env={e:{C6:()=>targets,L5:{warn(){}}},a:()=>({get:()=>{if(fail)throw Error('unavailable');return store}}),n:'consented',r:value=>createHash('sha256').update(value).digest('base64'),c:{status:'consented'},p:(items,_cb,gesture)=>({items,gesture})};vm.createContext(env);vm.runInContext(`${o};${f}`,env);return env;}
const digest=value=>createHash('sha256').update(value).digest('base64');
test('decision matches original f/o for trust, labels, former labels, changed values and store errors',()=>{
 const rows=[{key:'cmd',label:'new-label',formerLabels:['old-label'],value:'tool-a'},{key:'other',label:'other',value:'tool-b'}];
 for(const [store,fail] of [[{},false],[{'old-label':digest('tool-a'),other:digest('tool-b')},false],[{'new-label':digest('different')},false],[{},true]]){
  const nativeApi=native(rows,store,fail);const ours=createBootstrapConsent({getTargets:()=>rows,readConsents:()=>{if(fail)throw Error('unavailable');return store}});
  for(const trustedDelivery of [false,true]){const expected=nativeApi.f({}, {trustedDelivery,userAction:true}),actual=ours.check({}, {trustedDelivery});assert.equal(actual.status,expected.status);if(expected.status==='pending'){const result=expected.prompt(()=>{});assert.deepEqual(actual.targets,Array.from(result.items));assert.equal(result.gesture,true);}}
 }
});
test('trusted delivery does not access target extraction or storage',()=>{
 const c=createBootstrapConsent({getTargets:()=>{throw Error('unexpected')},readConsents:()=>{throw Error('unexpected')}});assert.deepEqual(c.check({}, {trustedDelivery:true}),{status:'consented'});
});
test('unapproved pending stays pending without recording or invoking a prompt',()=>{
 let reads=0;const c=createBootstrapConsent({getTargets:()=>[{label:'a',value:'x'}],readConsents:()=>{reads++;return {}}});assert.equal(c.check({}).status,'pending');assert.equal(c.check({}).status,'pending');assert.equal(reads,2);
});
