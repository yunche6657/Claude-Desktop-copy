'use strict';
const {createHash}=require('node:crypto');
// The injected store models electron-store's get/set; no prompt or UI is invoked.
function createBootstrapConsentStore({store}={}) {
  if(typeof store?.get!=='function'||typeof store?.set!=='function')throw new TypeError('store get/set required');
  const digest=value=>createHash('sha256').update(value).digest('base64');
  function pending(targets) {
    const saved=store.get('consented',{});
    return targets.filter(target=>{const hash=digest(target.value);return ![target.label,...target.formerLabels??[]].some(label=>saved[label]===hash);});
  }
  // Call only after an explicit allowed decision; preserve all prior labels.
  function recordAllowed(targets) {
    const saved={...store.get('consented',{})};
    for(const target of targets)saved[target.label]=digest(target.value);
    store.set('consented',saved);
  }
  return {pending,recordAllowed,readConsents:()=>store.get('consented',{})};
}
module.exports={createBootstrapConsentStore};
