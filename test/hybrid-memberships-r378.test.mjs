import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createHybridMemberships}=createRequire(import.meta.url)('../desktop/hybrid-memberships.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const uuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
test('account response sanitizes memberships and records owner only after successful current response',async()=>{
 const events=[],requests=[];
 const m=createHybridMemberships({fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({uuid:uuid.toUpperCase(),tagged_id:'acct-test',full_name:'User\u202eName',memberships:[{organization:{uuid:uuid.toUpperCase(),name:'Team\u0000',capabilities:['chat',3,'taint:hybrid_3p'],settings:{desktop_deployment_required:true}}},{organization:{uuid:'bad'}}]})}},noteOwner:(...args)=>events.push(['owner',...args]),recordIdentity:async(url,value,options)=>events.push(['record',url,value,options.isCurrent()])});
 await m.prime('https://fixture.invalid','synthetic',true,{bootstrapUrl:'https://fixture.invalid/bootstrap'});
 assert.equal(requests[0].url,'https://fixture.invalid/api/oauth/account');assert.equal(requests[0].options.headers['X-Authorization'],'Bearer synthetic');
 assert.deepEqual(m.getMemberships(),[{uuid,name:'Team',capabilities:['chat','taint:hybrid_3p'],required:true}]);assert.deepEqual(m.getAccount(),{email:undefined,name:'UserName'});
 assert.deepEqual(events,[['owner',uuid.toUpperCase(),'https://fixture.invalid/bootstrap'],['record','https://fixture.invalid/bootstrap',{accountUuid:uuid.toUpperCase(),accountTaggedId:'acct-test'},true]]);
 await m.prime('https://fixture.invalid','synthetic',true,{bootstrapUrl:'https://fixture.invalid/bootstrap'});assert.equal(requests.length,1);
});
test('a different token with identical public account data does not emit a change',async()=>{
 let notifications=0;const m=createHybridMemberships({fetch:async()=>({ok:true,json:async()=>({email_address:'  user  ',memberships:[]})})});
 m.onChange(()=>notifications++);await m.prime('https://fixture.invalid','first');await m.prime('https://fixture.invalid','second');
 assert.equal(notifications,1);assert.equal(m.getAccount().email,'  user  ');
});
test('invalidation rejects an older response and unauthorized response clears cached membership',async()=>{
 let next=deferred();const owners=[];const m=createHybridMemberships({fetch:()=>next.promise,noteOwner:id=>owners.push(id)});
 const old=m.prime('https://fixture.invalid','old',false,{bootstrapUrl:'old'});m.invalidate();
 next.resolve({ok:true,json:async()=>({uuid,memberships:[]})});await old;assert.equal(m.getMemberships(),undefined);assert.deepEqual(owners,[]);
 next=deferred();const fresh=m.prime('https://fixture.invalid','new');next.resolve({ok:true,json:async()=>({memberships:[]})});await fresh;assert.deepEqual(m.getMemberships(),[]);
 next=deferred();const denied=m.prime('https://fixture.invalid','other');next.resolve({ok:false,status:401});await denied;assert.equal(m.getMemberships(),undefined);
});
