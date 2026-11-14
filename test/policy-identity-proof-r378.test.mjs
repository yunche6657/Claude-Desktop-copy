import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {readIdentityBoundPolicy}=createRequire(import.meta.url)('../desktop/policy-identity-proof.cjs');
const accountId='11111111-1111-4111-8111-111111111111', orgId='22222222-2222-4222-8222-222222222222';
const setup=()=>{
 let mode=true, identity=true, profile={account:{uuid:accountId},organization:{uuid:orgId}}, policy={restrictions:{},compliance_taints:['hipaa']};
 const calls=[];
 return {calls, modeLease:{mode:'1p',isCurrent:()=>mode}, accountStore:{getActiveAccessToken:async()=> 'fixture-token',getActiveIdentitySnapshot:()=>({accountId,orgId,isCurrent:()=>identity})},
  fetchImpl:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>url.endsWith('/profile')?profile:policy}},
  changeMode:()=>{mode=false},changeIdentity:()=>{identity=false},setProfile:x=>{profile=x},setPolicy:x=>{policy=x}};
};
test('matching profile binds policy to current account and organization without exposing token',async()=>{
 const x=setup(),result=await readIdentityBoundPolicy(x);
 assert.equal(result.restricted,true);assert.equal(result.isCurrent(),true);assert.equal(result.accountId,accountId);
 assert.deepEqual(x.calls.map(c=>c.url),['https://api.anthropic.com/api/oauth/profile','https://api.anthropic.com/api/claude_code/policy_limits']);
 assert.equal(x.calls[0].opts.redirect,'error');assert.equal(JSON.stringify(result).includes('fixture-token'),false);
 x.changeIdentity();assert.equal(result.isCurrent(),false);
});
test('different, absent or malformed profile identity blocks the policy request',async()=>{
 for(const profile of [{account:{uuid:accountId},organization:{uuid:accountId}},{account:{uuid:accountId}},null]){
  const x=setup();x.setProfile(profile);assert.equal(await readIdentityBoundPolicy(x),null);assert.equal(x.calls.length,1);
 }
});
test('mode/identity invalidation and malformed policy fail closed',async()=>{
 for(const which of ['mode','identity','policy']){
  const x=setup(),fetch=x.fetchImpl;x.fetchImpl=async(...args)=>{const value=await fetch(...args);if(x.calls.length===2){if(which==='mode')x.changeMode();if(which==='identity')x.changeIdentity();if(which==='policy')x.setPolicy({restrictions:[],compliance_taints:[]});}return value};
  assert.equal(await readIdentityBoundPolicy(x),null);
 }
});
