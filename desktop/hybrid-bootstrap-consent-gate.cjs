'use strict';
const {createBootstrapConsent}=require('./hybrid-bootstrap-consent.cjs');
// Host owns trustedDelivery, target registry, UI and source identity.
function createHybridBootstrapConsentGate({getTargets,ledger,manager,onDeclined,getSourceIdentity,getCurrentConfig,displayTarget=target=>({display:target.label,detail:target.value,...target.origin?{origin:target.origin}:{}})}={}) {
 if(typeof getTargets!=='function'||typeof ledger?.readConsents!=='function'||typeof ledger?.recordAllowed!=='function'||typeof manager?.ask!=='function'||typeof onDeclined!=='function'||typeof getSourceIdentity!=='function'||typeof getCurrentConfig!=='function'||typeof displayTarget!=='function')throw new TypeError('consent gate dependencies required');
 // getCurrentConfig returns the latest candidate snapshot, not applied configuration.
 // Async ledger adapters must check isCurrent immediately before committing.
 let generation=0,active=false,queued;
 function invalidate(){generation++;}
 const signatureOf=targets=>JSON.stringify(targets.map(t=>[t.label,t.value,t.key,t.formerLabels]));
 function runNext(){
  if(active||!queued)return;
  const run=queued;queued=undefined;active=true;
  Promise.resolve().then(run).catch(()=>{}).finally(()=>{active=false;runNext();});
 }
 function check(config,{trustedDelivery=false,userAction=false,isCurrent=()=>true}={}) {
  const source=getSourceIdentity();
  const decision=createBootstrapConsent({getTargets,readConsents:()=>ledger.readConsents()});
  const result=decision.check(config,{trustedDelivery});if(result.status!=='pending')return result;
  const epoch=generation,targets=result.targets.map(t=>({...t,formerLabels:t.formerLabels?[...t.formerLabels]:undefined}));
  const signature=signatureOf(getTargets(config));let invoked=false;
  const current=()=>epoch===generation&&isCurrent()&&Object.is(source,getSourceIdentity())&&signatureOf(getTargets(getCurrentConfig()))===signature;
  return {status:'pending',prompt(done){
   if(invoked)return;invoked=true;
   queued=async()=>{
    if(!current())return;
    if(decision.check(getCurrentConfig()).status==='consented'){done();return;}
    let choice;try{choice=await manager.ask({kind:'apply',targets:targets.map(displayTarget)},{userAction});}catch{choice='error';}
    if(choice!=='allow') {if(current())await onDeclined(choice);return;}
    if(!current())return;
    await ledger.recordAllowed(targets,{isCurrent:current});
    if(current()&&decision.check(getCurrentConfig()).status==='consented')done();
   };
   runNext();
  }};
 }
 return {check,invalidate};
}
module.exports={createHybridBootstrapConsentGate};
