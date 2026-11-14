'use strict';
// Dtn: a validated remote response is usable only when it has a supplied
// field or when an unreadable non-desktop execution target requires fallback.
// The caller must provide the real schema/policy intake and diagnostics.
function createBootstrapResponseValidator({intake, hasNonDesktopFailure, describeFailure, allowLoopbackResponseUrls=false}={}) {
 if(typeof intake!=='function'||typeof hasNonDesktopFailure!=='function'||typeof describeFailure!=='function')throw new TypeError('bootstrap validation dependencies required');
 return function validate({json,bootstrapUrl,trustedOrigin,oidc,hybrid,trustedDelivery,now,etag,respStatus,isCurrent=()=>true}) {
  if(!isCurrent())return {ok:false,kind:'stale'};
  const result=intake(json,hybrid||oidc?undefined:trustedOrigin,{allowLoopbackResponseUrls,channel:hybrid?'hybrid':'bootstrap'});
  const {config,rejected=[],warnings=[],keyedParseErrors=[]}=result;
  const suppliedKeys=Object.keys(config).filter(key=>key!=='expiresAt');
  if(!suppliedKeys.length&&!hasNonDesktopFailure(keyedParseErrors))return {ok:false,kind:'parse',status:respStatus,detail:describeFailure(keyedParseErrors,config)};
  if(!isCurrent())return {ok:false,kind:'stale'};
  return {ok:true,value:config,suppliedKeys,warnings,keyedParseErrors,fetchedAt:now,etag,sourceUrl:bootstrapUrl,trustedDelivery};
 };
}
module.exports={createBootstrapResponseValidator};
