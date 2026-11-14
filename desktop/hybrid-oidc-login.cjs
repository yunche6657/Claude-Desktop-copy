'use strict';
const http = require('node:http');
const {randomBytes,createHash} = require('node:crypto');

function createHybridOidcLogin({openBrowser,fetch:fetchImpl,slotStore,assertTokenBoundToHybridOrg,beforePersist,afterPersist,now=Date.now}={}) {
  if(typeof openBrowser!=='function'||typeof fetchImpl!=='function'||typeof assertTokenBoundToHybridOrg!=='function'||typeof slotStore?.write!=='function') throw new TypeError('openBrowser, fetch, slotStore.write and org binding are required');
  const locks=new Map(), active=new Set(); let generation=0;
  const allowed=url=>{const parsed=new URL(url);if(parsed.protocol!=='https:' && !(parsed.protocol==='http:'&&parsed.hostname==='127.0.0.1'))throw new Error('OAuth endpoint must use https or loopback HTTP');return parsed;};
  function singleflight(key,fn){let held=locks.get(key);if(!held){held=fn().finally(()=>{if(locks.get(key)===held)locks.delete(key)});locks.set(key,held);}return held;}
  async function revoke(oidc,cred){
    const jobs=[['accessToken','access_token'],['refreshToken','refresh_token']].filter(([field])=>cred[field]).map(([field,hint])=>Promise.resolve().then(()=>fetchImpl(`${oidc.apiOrigin}/v1/oauth/token/revoke`,{method:'POST',headers:{'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({token:cred[field],token_type_hint:hint,client_id:oidc.clientId}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)})));
    await Promise.allSettled(jobs);
  }
  async function run(oidc,{signal,callbackTimeoutMs=120000,isCurrent=()=>true}={}, requestedGeneration=generation) {
    if(!oidc||typeof oidc.storeKey!=='string'||!oidc.storeKey)throw new TypeError('OIDC storeKey required');
    const authorize=allowed(oidc.authorizationUrl);allowed(oidc.tokenUrl);
    if(typeof oidc.clientId!=='string'||!oidc.clientId||typeof oidc.scopes!=='string')throw new TypeError('OIDC client and scopes required');
    const epoch=requestedGeneration, controller=new AbortController();active.add(controller);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const check=()=>{combined.throwIfAborted();if(epoch!==generation||!isCurrent())throw new Error('OAuth context changed');};
    let server, credential, cleanup;
    try {
      check();
      const verifier=randomBytes(32).toString('base64url'), challenge=createHash('sha256').update(verifier).digest('base64url'),state=randomBytes(24).toString('base64url');
      server=http.createServer();
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});check();
      const host=`127.0.0.1:${server.address().port}`,redirect=`http://${host}/callback`;
      for(const [k,v] of Object.entries({response_type:'code',client_id:oidc.clientId,redirect_uri:redirect,state,code_challenge:challenge,code_challenge_method:'S256',scope:oidc.scopes})) if(v)authorize.searchParams.set(k,v);
      const callback=new Promise((resolve,reject)=>{
        let done=false;
        const finish=(error,code)=>{if(done)return;done=true;cleanup();error?reject(error):resolve(code);};
        const timeout=setTimeout(()=>finish(new Error('OAuth callback timed out')),Math.min(600000,Math.max(30000,callbackTimeoutMs)));timeout.unref?.();
        const aborted=()=>finish(combined.reason??new Error('OAuth aborted'));
        const request=(req,res)=>{
          const fail=(status,text='Authorization failed')=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});res.end(text);};
          if(req.headers.host!==host){fail(400);return;}
          let url;try{url=new URL(req.url??'',`http://${host}`)}catch{fail(400);return;}
          if(url.pathname!=='/callback'){fail(404);return;}
          if(url.searchParams.get('state')!==state){fail(400);return;}
          if(req.headers.referer){let ref;try{ref=new URL(req.headers.referer).hostname}catch{};if(ref!==authorize.hostname){fail(400);finish(new Error('OAuth referrer rejected'));return;}}
          if(url.searchParams.get('error')){fail(200);finish(new Error('OAuth authorization denied'));return;}
          const code=url.searchParams.get('code');if(!code){fail(400);finish(new Error('OAuth callback missing code'));return;}
          res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('Authorization complete. You can close this window.');finish(null,code);
        };
        cleanup=()=>{clearTimeout(timeout);combined.removeEventListener('abort',aborted);server?.removeListener('request',request);};
        combined.addEventListener('abort',aborted,{once:true});server.on('request',request);if(combined.aborted)aborted();
      });
      // Attach a rejection handler immediately while the host opens the URL.
      callback.catch(()=>{});
      const opened=Promise.resolve().then(()=>openBrowser(authorize.toString()));
      const code=await Promise.race([callback,opened.then(()=>callback)]);check();cleanup();server.close();server=undefined;
      const body={grant_type:'authorization_code',code,redirect_uri:redirect,client_id:oidc.clientId,code_verifier:verifier,state};
      const response=await fetchImpl(oidc.tokenUrl,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json',Accept:'application/json','anthropic-version':'2023-06-01'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([combined,AbortSignal.timeout(30000)])});
      if(!response.ok)throw new Error(`OAuth token exchange failed (HTTP ${response.status})`);
      let data;try{data=await response.json()}catch{throw new Error('OAuth token response was not JSON')}
      if(!data?.access_token)throw new Error('OAuth token response missing access token');
      const scopes=oidc.scopes.split(/\s+/).filter(Boolean), refreshExpiry=data.refresh_token_expires_in??data.refresh_expires_in;
      credential={accessToken:data.access_token,refreshToken:data.refresh_token,idToken:data.id_token,
        expiresAt:typeof data.expires_in==='number'?now()+data.expires_in*1000:data.refresh_token?now()+3600000:undefined,
        refreshTokenExpiresAt:typeof refreshExpiry==='number'&&refreshExpiry>0?now()+refreshExpiry*1000:undefined,
        grantedScopes:data.scope?data.scope.split(/[\s,]+/).filter(Boolean):scopes,requestedScopes:scopes,tokenUrl:oidc.tokenUrl,clientId:oidc.clientId};
      let writeStarted=false, receipt, preserveGrant=false, identity;
      try {
        check();identity=await assertTokenBoundToHybridOrg(oidc,credential.accessToken,{fetch:fetchImpl,signal:combined});check();
        if (beforePersist) {
          const result=beforePersist({oidc,accountUuid:identity?.accountUuid});
          if (result && typeof result.then === 'function') throw new TypeError('beforePersist must be synchronous');
        }
        check();writeStarted=true;
        try {
          const written=slotStore.write(oidc.storeKey,credential,{isCurrent:()=>!combined.aborted&&epoch===generation&&isCurrent()});
          // A synchronous commit is checked before yielding to a microtask.
          receipt=written && typeof written.then==='function' ? await written : written;
        } catch(error) {
          receipt=error?.receipt;
          if (error?.code === 'HYBRID_ENCRYPTION_UNAVAILABLE' && error?.credentialRetained === true) {
            check(); preserveGrant=true; throw error;
          }
          if (!(error?.credentialRetained === true && error?.memoryOnly === true && error?.code !== 'HYBRID_ENCRYPTION_UNAVAILABLE')) throw error;
        }
        check();
      } catch(error) {
        if (preserveGrant) throw error;
        let safeToRevoke=!writeStarted || error?.slotUnchanged===true;
        if(receipt && typeof receipt.rollbackIfCurrent==='function') {
          try { safeToRevoke=(await receipt.rollbackIfCurrent()) === true; }
          catch(rollbackError) { throw new AggregateError([error,rollbackError],'OAuth login failed and slot rollback failed'); }
        }
        if(safeToRevoke) await revoke(oidc,credential);
        throw error;
      }
      if (identity?.accountUuid && afterPersist) await afterPersist({oidc,accountUuid:identity.accountUuid,isCurrent:()=>!combined.aborted&&epoch===generation&&isCurrent()});
      return {ok:true,...identity?.accountUuid?{accountUuid:identity.accountUuid}:{}};
    } finally {cleanup?.();if(server)server.close();active.delete(controller);}
  }
  function signIn(oidc,options){if(!oidc||typeof oidc.storeKey!=='string')return Promise.reject(new TypeError('OIDC storeKey required'));const epoch=generation;return singleflight(oidc.storeKey,()=>run(oidc,options,epoch));}
  function invalidate(){generation++;locks.clear();for(const controller of active)controller.abort();}
  return {signIn,invalidate};
}
module.exports={createHybridOidcLogin};
