'use strict';
const {createHash}=require('node:crypto');
// This decision alone does not display a prompt or persist consent. The host
// supplies the native local-execution target registry and consent-store reader.
function createBootstrapConsent({getTargets,readConsents}={}) {
  if(typeof getTargets!=='function'||typeof readConsents!=='function') throw new TypeError('getTargets and readConsents are required');
  function check(config,{trustedDelivery=false}={}) {
    if(trustedDelivery)return {status:'consented'};
    const targets=getTargets(config); let pending;
    try {
      const consents=readConsents();
      pending=targets.filter(target=>{
        const digest=createHash('sha256').update(target.value).digest('base64');
        return ![target.label,...target.formerLabels??[]].some(label=>consents[label]===digest);
      });
    } catch { pending=targets; }
    return pending.length ? {status:'pending',targets:pending} : {status:'consented'};
  }
  return {check};
}
module.exports={createBootstrapConsent};
