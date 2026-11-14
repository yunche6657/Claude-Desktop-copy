import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createHybridBootstrapFetch}=require('../desktop/hybrid-bootstrap-fetch.cjs');
test('hybrid 401 invokes foreground credential invalidation only while current; 403 is HTTP',async()=>{
 const calls=[];let status=401;const client=createHybridBootstrapFetch({resolveAuth:async()=>({ok:true,bearer:'fixture',oidc:{storeKey:'slot'}}),fetch:async()=>new Response(null,{status}),onUnauthorized:async({oidc,isCurrent})=>{if(isCurrent())calls.push(oidc.storeKey)},validate:()=>({ok:true})});
 assert.equal((await client.run('https://fixture.invalid')).kind,'auth');assert.deepEqual(calls,['slot']);
 assert.equal((await client.run('https://fixture.invalid',{background:true})).kind,'auth');assert.deepEqual(calls,['slot']);
 status=403;assert.equal((await client.run('https://fixture.invalid')).kind,'http');assert.deepEqual(calls,['slot']);
});
