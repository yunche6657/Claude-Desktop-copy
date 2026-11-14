import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createHybridBootstrapFetch}=require('../desktop/hybrid-bootstrap-fetch.cjs');
test('bootstrap auth forwards background and preserves native parse/retryAt detail',async()=>{
 let seen,result={ok:false,kind:'parse',detail:'invalid control-plane URL'};const client=createHybridBootstrapFetch({resolveAuth:async(_url,opts)=>{seen=opts;return result},fetch:async()=>{throw Error('must not fetch')},validate:()=>{}});
 assert.deepEqual(await client.run('https://fixture.invalid',{background:true}),result);assert.equal(seen.background,true);assert.equal(seen.isCurrent(),true);
 result={ok:false,kind:'unreachable',retryAt:123};assert.deepEqual(await client.run('https://fixture.invalid'),result);assert.equal(seen.background,false);
 result={ok:false,kind:'auth',detail:'private'};assert.deepEqual(await client.run('https://fixture.invalid'),{ok:false,kind:'auth'});
});
