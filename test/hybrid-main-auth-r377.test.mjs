import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../desktop/main.cjs',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
test('actual main bearer resolution cannot overwrite newer auth status with an old completion',async()=>{
 const start=source.indexOf('resolveBearer: async oidc => {');assert.ok(start>0);
 const end=source.indexOf('\n    },',start);assert.ok(end>start);
 const code=source.slice(start+'resolveBearer: '.length,end)+'\n}';
 const old=deferred(),fresh=deferred();let calls=0;
 const results=new Map(),requests=new Map();
 const resolve=vm.runInNewContext(`(${code})`,{hybridAuthResults:results,hybridAuthRequests:requests,hybridOidcSession:{getBearer:()=>++calls===1?old.promise:fresh.promise}});
 const a=resolve({storeKey:'same'}),b=resolve({storeKey:'same'});
 fresh.resolve({ok:true,bearer:'synthetic'});await b;old.resolve({ok:false,kind:'auth'});await a;
 assert.equal(results.get('same'),'ready');assert.equal(requests.size,0);
});
test('actual main bootstrap auth rejects absent config before opening any browser',async()=>{
 const start=source.indexOf('triggerBootstrapAuth: async args => {');const end=source.indexOf('\n    resetWindowBounds:',start);
 assert.ok(start>0&&end>start);
 const code=source.slice(start+'triggerBootstrapAuth: '.length,end).trim().replace(/,$/,'');let opens=0;
 const run=vm.runInNewContext(`(${code})`,{hybridLogin:{signIn:()=>{opens++;}},bridge:{getMainGrowthBookSourceConfig:()=>({})}});
 await assert.rejects(run(),/bootstrap is not configured/);assert.equal(opens,0);
});
