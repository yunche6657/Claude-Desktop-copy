'use strict';
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const strip = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '') : '';
const clean = value => strip(value).slice(0,256);
const accountField = value => { const text=strip(value); return text.length ? text.slice(0,255) : undefined; };

// L5t: cache and coalesce by bearer digest; epoch invalidation rejects late results.
function createHybridMemberships({fetch, noteOwner = () => {}, recordIdentity = async () => {}, loadIdentity = async () => ({ noteOwner, recordIdentity })}) {
  let memberships, account, digest, pending, pendingDigest, epoch = 0;
  const listeners = new Set();
  function publish(next) {
    const changed = JSON.stringify([memberships,account]) !== JSON.stringify([next.memberships,next.account]);
    ({memberships,account,digest}=next);
    if (changed) for(const fn of listeners) { try { fn(); } catch {} }
  }
  function invalidate() { epoch++; pending=undefined;pendingDigest=undefined;publish({memberships,account:undefined,digest}); }
  function clear() { epoch++;pending=undefined;pendingDigest=undefined;publish({memberships:undefined,account:undefined,digest:undefined}); }
  function prime(apiOrigin, bearer, xAuthorization = false, owner) {
    const hash=crypto.createHash('sha256').update(bearer).digest('base64url');
    if (memberships && digest===hash) return Promise.resolve();
    if (pending && pendingDigest===hash) return pending;
    const generation=++epoch;pendingDigest=hash;
    const work=(async()=>{
      try {
        const auth=`Bearer ${bearer}`;
        const response=await fetch(`${apiOrigin}/api/oauth/account`,{headers:{Authorization:auth,...xAuthorization?{'X-Authorization':auth}:{}},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
        if (!response.ok) { if(generation===epoch && (response.status===401||response.status===403)) publish({memberships:undefined,account:undefined,digest:undefined});return; }
        const body=await response.json(), rows=[];
        for(const row of body.memberships??[]) {
          const org=row?.organization;if(!UUID.test(org?.uuid??''))continue;
          const capabilities=Array.isArray(org.capabilities)?org.capabilities.filter(v=>typeof v==='string'):[];
          rows.push({uuid:org.uuid.toLowerCase(),name:clean(org.name),capabilities,required:org.settings?.desktop_deployment_required===true&&capabilities.includes('taint:hybrid_3p')||undefined});
        }
        if(generation!==epoch)return;
        const email=accountField(body.email_address), name=accountField(body.full_name)??accountField(body.display_name);
        publish({memberships:rows,account:email||name?{email,name}:undefined,digest:hash});
        if(owner) {
          const identity = await loadIdentity();
          if(generation!==epoch)return;
          const id=UUID.test(body.uuid??'')?body.uuid:undefined;identity.noteOwner(id,owner.bootstrapUrl);
          if(id)await identity.recordIdentity(owner.bootstrapUrl,{accountUuid:id,accountTaggedId:typeof body.tagged_id==='string'?body.tagged_id:undefined},{isCurrent:()=>generation===epoch});
        }
      } catch { /* Native retains previous cache on transport or parse failure. */ }
      finally { if(generation===epoch){pending=undefined;pendingDigest=undefined;} }
    })();pending=work;return work;
  }
  return {prime,invalidate,clear,getMemberships:()=>memberships,getAccount:()=>account,onChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
}
module.exports={createHybridMemberships};
