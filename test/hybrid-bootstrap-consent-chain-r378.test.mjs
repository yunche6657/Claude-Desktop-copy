import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createHybridBootstrapFetch}=require('../desktop/hybrid-bootstrap-fetch.cjs'),{createBootstrapConsent}=require('../desktop/hybrid-bootstrap-consent.cjs'),{createHybridBootstrapCandidate}=require('../desktop/hybrid-bootstrap-candidate.cjs');
test('controlled remote candidate waits for approval and revalidates a changed target',async t=>{
 let current='one',requests=0,approval,applied=[],cached=[],doneResolve;const done=new Promise(r=>doneResolve=r),records={};
 const server=http.createServer((_req,res)=>{requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({command:current}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}/bootstrap`;
 // The registry and remote schema below are deliberately controlled fixtures.
 const consent=createBootstrapConsent({getTargets:config=>[{label:'fixture.command',value:config.command}],readConsents:()=>records});
 const fetcher=createHybridBootstrapFetch({fetch,resolveAuth:async()=>({ok:true,headers:{}}),validate:({json})=>({ok:true,value:json})});
 const candidate=createHybridBootstrapCandidate({fetchCandidate:()=>fetcher.run(url),validateCandidate:async c=>typeof c.value.command==='string',checkConsent:async config=>{let state=consent.check(config);return state.status==='pending'?{...state,prompt:cb=>approval=cb}:state},applyCandidate:async(c,{isCurrent})=>{if(isCurrent())applied.push(c.value.command)},validateApplied:async()=>true,cacheCandidate:async(c,{isCurrent})=>{if(isCurrent()){cached.push(c.value.command);doneResolve()}}});
 assert.equal((await candidate.resolve()).kind,'pending');assert.deepEqual(applied,[]);assert.equal(requests,1);
 records['fixture.command']=createHash('sha256').update('one').digest('base64');current='two';approval();for(let i=0;i<100&&requests<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(requests,2);assert.deepEqual(applied,[]);assert.deepEqual(cached,[]);
 records['fixture.command']=createHash('sha256').update('two').digest('base64');approval();await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('approval timeout')),2000))]);assert.deepEqual(applied,['two']);assert.deepEqual(cached,['two']);assert.equal(requests,3);
});
