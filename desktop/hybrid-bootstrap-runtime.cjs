'use strict';
const {createHybridBootstrapAuth}=require('./hybrid-bootstrap-auth.cjs');
const {createHybridBootstrapFetch}=require('./hybrid-bootstrap-fetch.cjs');
const {createHybridBootstrapCache}=require('./hybrid-bootstrap-cache.cjs');
const {createHybridBootstrapCandidate}=require('./hybrid-bootstrap-candidate.cjs');
const {createHybridBootstrapScheduler}=require('./hybrid-bootstrap-scheduler.cjs');

// All policy-bearing dependencies are mandatory; this is not a default policy.
function createHybridBootstrapRuntime({getConfig,oidcFor,session,fetch,validateResponse,validateCandidate,checkConsent,applyCandidate,validateApplied,trustedDelivery,intervalMinutes,wantsQuickConfirm,sourceIdentity,now=Date.now,schedulerOptions={}}={}) {
 for(const fn of [getConfig,oidcFor,fetch,validateResponse,validateCandidate,checkConsent,applyCandidate,validateApplied,trustedDelivery,intervalMinutes,wantsQuickConfirm,sourceIdentity])if(typeof fn!=='function')throw new TypeError('bootstrap runtime dependencies required');
 let generation=0,disposed=false,identity=sourceIdentity(getConfig()),started=false,scheduler;
 const configured=()=>{const b=getConfig()?.bootstrap;return !!b?.url&&b.enabled===true;};
 const auth=createHybridBootstrapAuth({oidcFor,session});
 const request=createHybridBootstrapFetch({resolveAuth:async(...args)=>{synchronize();const result=await auth.resolveAuth(...args);synchronize();return result;},
  onUnauthorized:async args=>{synchronize();return auth.onUnauthorized(args);},fetch,validate:validateResponse,now});
 const cache=createHybridBootstrapCache({getConfig,now,trustedDelivery,captureCredentialGeneration:()=>{const epoch=generation;return ()=>{synchronize();return disposed||generation!==epoch;};},
  fetchBootstrap:async(url,_oidc,_started,previous,trusted,background)=>{const epoch=generation,owner=scheduler;const result=await request.run(url,{previous,trustedDelivery:trusted,background});synchronize();
   if(background&&!disposed&&generation===epoch&&scheduler===owner&&(result.ok||result.status!==undefined))owner.markOnline();return result;}});
 const candidate=createHybridBootstrapCandidate({fetchCandidate:options=>{synchronize();return cache.resolve(options);},validateCandidate,
  checkConsent:async(value,options)=>{const epoch=generation;const result=await checkConsent(value,options);if(result?.status!=='pending')return result;
   return {...result,prompt:done=>result.prompt(()=>{synchronize();if(!disposed&&epoch===generation)done();})};},
  applyCandidate:async(value,{isCurrent})=>applyCandidate(value,{isCurrent:()=>{synchronize();return isCurrent()&&!disposed&&getConfig()?.bootstrap?.url===value.sourceUrl;}}),validateApplied,
  cacheCandidate:async(value,{isCurrent})=>{synchronize();if(isCurrent()&&!disposed&&getConfig()?.bootstrap?.url===value.sourceUrl)cache.setLastServed(value);},clearFetchCache:cache.clearFetchCache});
 function makeScheduler(){return createHybridBootstrapScheduler({...schedulerOptions,intervalMinutes,wantsQuickConfirm,isConfigured:configured,refresh:()=>{synchronize();return candidate.resolve({background:true,bypassCache:true});},now});}
 scheduler=makeScheduler();
 function synchronize(){if(disposed)return;const next=sourceIdentity(getConfig());if(!Object.is(next,identity)){identity=next;invalidate();scheduler.dispose();scheduler=makeScheduler();if(started)scheduler.start();}}
 function invalidate(){generation++;session.invalidate?.();request.invalidate();candidate.invalidate();cache.clearFetchCache();cache.setLastServed(undefined);}
 function dispose(){if(disposed)return;disposed=true;invalidate();scheduler.dispose();}
 return {resolve:options=>{synchronize();return disposed?Promise.resolve({kind:'stale'}):candidate.resolve(options);},invalidate,dispose,start:()=>{synchronize();started=true;scheduler.start();},confirm:()=>{synchronize();scheduler.confirm();},getLastServed:()=>{synchronize();return cache.getLastServed();}};
}
module.exports={createHybridBootstrapRuntime};
