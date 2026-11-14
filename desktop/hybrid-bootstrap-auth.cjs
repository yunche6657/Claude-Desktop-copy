'use strict';
// Per-request proofs are attached to a fresh opaque OIDC wrapper; no token or
// epoch is shared through mutable global request state.
function createHybridBootstrapAuth({oidcFor,session}={}) {
 if(typeof oidcFor!=='function'||typeof session?.getBootstrapBearer!=='function'||typeof session?.captureEpoch!=='function'||typeof session?.rejectAccess!=='function')throw new TypeError('OIDC derivation and session are required');
 const proofs=new WeakMap();
 async function resolveAuth(url,{background=false,isCurrent=()=>true}={}) {
  const oidc=await oidcFor(url);if(!isCurrent())return {ok:false,kind:'stale'};
  const epoch=session.captureEpoch();const result=await session.getBootstrapBearer(oidc,{background});
  if(!isCurrent()||session.captureEpoch()!==epoch)return {ok:false,kind:'stale'};
  if(!result?.ok)return result;
  if(typeof result.bearer!=='string'||!result.bearer)throw new TypeError('invalid hybrid bearer');
  const requestOidc=Object.freeze({...oidc});proofs.set(requestOidc,{epoch,bearer:result.bearer});
  const headers={Authorization:`Bearer ${result.bearer}`,...oidc.xAuthorization?{'X-Authorization':`Bearer ${result.bearer}`}:{}};
  return {ok:true,oidc:requestOidc,bearer:result.bearer,headers};
 }
 async function onUnauthorized({oidc,bearer,isCurrent=()=>true}={}) {
  const proof=oidc&&proofs.get(oidc);if(!proof||proof.bearer!==bearer||!isCurrent())return {ok:false,kind:'stale'};
  proofs.delete(oidc);
  return session.rejectAccess(oidc,proof);
 }
 return {resolveAuth,onUnauthorized};
}
module.exports={createHybridBootstrapAuth};
