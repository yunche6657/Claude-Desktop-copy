import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import vm from 'node:vm';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);const {createBootstrapConsentStore}=require('../desktop/hybrid-bootstrap-consent-store.cjs');
const source=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-xoZNrP6a.js',import.meta.url),'utf8');const fragment=source.slice(source.indexOf('function o(e)'),source.indexOf('var c={status:'));assert.ok(fragment.includes('function s(e)'));
const hash=value=>createHash('sha256').update(value).digest('base64');
function setup(initial){let saved={...initial},writes=0;const store={get:(key,fallback)=>{assert.equal(key,'consented');return saved??fallback},set:(key,value)=>{assert.equal(key,'consented');saved=value;writes++}};return {store,get:()=>saved,count:()=>writes};}
const plain=x=>JSON.parse(JSON.stringify(x));
test('upstream o/s VM matches existing and former labels, changes and merge writes',()=>{
 const initial={old:hash('same'),unrelated:'preserved',now:hash('stale')};const nativeStore=setup(initial),actualStore=setup(initial);const sandbox={a:()=>nativeStore.store,n:'consented',r:hash};vm.createContext(sandbox);vm.runInContext(fragment,sandbox);const api=createBootstrapConsentStore({store:actualStore.store});
 const rows=[{label:'now',formerLabels:['old'],value:'same'},{label:'next',value:'new'},{label:'other',value:'x'}];assert.deepEqual(plain(api.pending(rows)),plain(sandbox.o(rows)));assert.equal(actualStore.count(),0);
 const approved=api.pending(rows);api.recordAllowed(approved);sandbox.s(sandbox.o(rows));assert.deepEqual(plain(actualStore.get()),plain(nativeStore.get()));assert.equal(actualStore.get().old,initial.old);assert.equal(actualStore.get().unrelated,'preserved');assert.equal(actualStore.count(),1);assert.deepEqual(api.pending(rows),[]);
});
test('read and write failures propagate so caller can preserve pending state',()=>{
 const read=createBootstrapConsentStore({store:{get:()=>{throw Error('read failed')},set:()=>{}}});assert.throws(()=>read.pending([{label:'a',value:'x'}]),/read failed/);
 const write=createBootstrapConsentStore({store:{get:()=>({}),set:()=>{throw Error('write failed')}}});assert.throws(()=>write.recordAllowed([{label:'a',value:'x'}]),/write failed/);
});
