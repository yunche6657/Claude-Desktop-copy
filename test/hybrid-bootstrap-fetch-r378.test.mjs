import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
const {createHybridBootstrapFetch}=createRequire(import.meta.url)('../desktop/hybrid-bootstrap-fetch.cjs');
test('authenticated bootstrap primes correct account origin, passes raw response to validation, and supports 304',async()=>{
 const requests=[], primes=[];const server=http.createServer((req,res)=>{requests.push(req.headers);if(req.headers['if-none-match']){res.writeHead(304);return res.end();}res.writeHead(200,{'content-type':'application/json',etag:'"fixture"'});res.end(JSON.stringify({models:['fixture']}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/bootstrap`;
 const bootstrap=createHybridBootstrapFetch({fetch,now:()=>42,resolveAuth:async()=>({ok:true,bearer:'synthetic',oidc:{apiOrigin:'https://account.invalid',orgUuid:'test-org',xAuthorization:true},headers:{Authorization:'Bearer synthetic'}}),primeMemberships:(...args)=>primes.push(['memberships',...args]),primeModels:arg=>primes.push(['models',arg]),validate:input=>({ok:true,value:input.json,etag:input.etag,fetchedAt:input.now})});
 try{const first=await bootstrap.run(url);await new Promise(r=>setImmediate(r));assert.deepEqual(first.value,{models:['fixture']});assert.equal(first.etag,'"fixture"');assert.equal(requests[0].authorization,'Bearer synthetic');assert.equal(primes[0][1],'https://account.invalid');assert.equal(primes[0][4].bootstrapUrl,url);assert.equal(primes[1][1].orgUuid,'test-org');
  const second=await bootstrap.run(url,{previous:{value:first.value,etag:first.etag,suppliedKeys:['models']}});assert.equal(second.notModified,true);assert.deepEqual(second.value,first.value);assert.equal(requests[1]['if-none-match'],'"fixture"');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('refused auth, malformed response and invalidated request never apply configuration',async()=>{
 let calls=0,resolve;const pending=new Promise(r=>resolve=r);
 const api=createHybridBootstrapFetch({resolveAuth:async()=>({ok:true}),fetch:()=>{calls++;return pending;},validate:()=>{throw Error('must not apply');}});
 const work=api.run('https://fixture.invalid/bootstrap');await new Promise(r=>setImmediate(r));api.invalidate();resolve(new Response('{}',{status:200}));assert.deepEqual(await work,{ok:false,kind:'stale'});assert.equal(calls,1);
 const denied=createHybridBootstrapFetch({resolveAuth:async()=>({ok:false,kind:'auth'}),fetch:()=>{throw Error('must not fetch');},validate:()=>{}});assert.deepEqual(await denied.run('https://fixture.invalid/bootstrap'),{ok:false,kind:'auth'});
 const invalid=createHybridBootstrapFetch({resolveAuth:async()=>({ok:true}),fetch:async()=>new Response('[]',{status:200}),validate:()=>{throw Error('must not apply');}});assert.equal((await invalid.run('https://fixture.invalid/bootstrap')).kind,'parse');
});
