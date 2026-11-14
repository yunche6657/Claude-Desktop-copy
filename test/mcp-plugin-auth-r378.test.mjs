import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createPluginAuthIssuer}=createRequire(import.meta.url)('../desktop/mcp-plugin-auth.cjs');
const keys=['account','organization','installation','enablement','manifest','effectiveServer','conflicts'];
function fixture() {
 let actor={actorToken:'a',generation:1}, tenant={accountId:'u',organizationId:'o'}, revision='1',live=true;
 let servers=[{serverName:'plugin:p:s',pluginId:'p',enabled:true,effective:true,url:'https://example.test/mcp'}];
 let coverage=Object.fromEntries(keys.map(k=>[k,true]));
 let make=()=>({complete:true,coverage,revision,accountId:'u',organizationId:'o',servers,isCurrent:()=>live});
 const issuer=createPluginAuthIssuer({getActor:()=>actor,getTenant:()=>tenant,getSource:()=>make()});
 const issue=()=>issuer.issueVerified({sessionId:'s',serverName:'plugin:p:s',actorToken:'a',generation:1});
 return {issuer,issue,actor:v=>actor=v,tenant:v=>tenant=v,revision:v=>revision=v,live:v=>live=v,servers:v=>servers=v,coverage:v=>coverage=v,source:v=>make=v};
}
test('private complete source yields revocable registry-compatible proof',()=>{
 const f=fixture(), p=f.issue(); assert.equal(p.url,'https://example.test/mcp'); assert.equal(p.isCurrent(),true);
 f.revision('2'); assert.equal(p.isCurrent(),false); f.revision('1'); assert.equal(p.isCurrent(),false);
 const q=f.issue(); f.issuer.retireSession('s'); assert.equal(q.isCurrent(),false);
});
test('actor generation, account, organization and source invalidation revoke',()=>{
 for(const mutate of [f=>f.actor({actorToken:'a',generation:2}),f=>f.actor({actorToken:'b',generation:1}),f=>f.tenant({accountId:'v',organizationId:'o'}),f=>f.tenant({accountId:'u',organizationId:'other'}),f=>f.live(false)]) {
  const f=fixture(),p=f.issue(); mutate(f); assert.equal(p.isCurrent(),false);
 }
});
test('missing coverage, ambiguous, disabled, invalid and changed source fail closed',()=>{
 for(const key of keys){const f=fixture();f.coverage(Object.fromEntries(keys.map(k=>[k,k!==key])));assert.equal(f.issue(),null);}
 for(const rows of [[],[{serverName:'plugin:p:s',pluginId:'p',enabled:true,effective:true,url:'https://a.test'},{serverName:'plugin:p:s',pluginId:'q',enabled:true,effective:true,url:'https://a.test'}],[{serverName:'plugin:p:s',pluginId:'p',enabled:false,effective:true,url:'https://a.test'}],[{serverName:'plugin:p:s',pluginId:'p',enabled:true,effective:true,url:'https://user:pass@a.test'}]]){const f=fixture();f.servers(rows);assert.equal(f.issue(),null);}
 const f=fixture(),p=f.issue();f.servers([{serverName:'plugin:p:s',pluginId:'p',enabled:true,effective:true,url:'https://other.test'}]);assert.equal(p.isCurrent(),false);
});
test('provider exceptions, missing data and reentrant actor replacement do not issue',()=>{
 const f=fixture();f.source(()=>{throw Error('unavailable')});assert.equal(f.issue(),null);
 const g=fixture();g.source(()=>{g.actor({actorToken:'b',generation:2});return {}});assert.equal(g.issue(),null);
 assert.throws(()=>createPluginAuthIssuer({}),TypeError);
});

test('registry binds issuer proof and revokes even after source returns to prior URL',()=>{
 const {createMcpAuthBindingRegistry}=createRequire(import.meta.url)('../desktop/mcp-auth-binding.cjs');
 let live=true, url='https://example.test/mcp', rev=0;
 const getActor=()=>({actorToken:'a',generation:1});
 const authority=createPluginAuthIssuer({getActor,getTenant:()=>({accountId:'u',organizationId:'o'}),getSource:()=>{
  const currentRev=rev;
  return {complete:true,coverage:Object.fromEntries(keys.map(k=>[k,true])),revision:String(currentRev),accountId:'u',organizationId:'o',servers:[{serverName:'server',pluginId:'p',enabled:true,effective:true,url}],isCurrent:()=>live&&rev===currentRev};
 }});
 const registry=createMcpAuthBindingRegistry({getActor,issueVerified:authority.issueVerified});
 assert.equal(registry.establishVerified('s','server','a'),true);
 const bound=registry.get('s','server','a');assert.equal(bound.kind,'verified');assert.equal(bound.url,url);
 url='https://other.test/mcp';rev++;url='https://example.test/mcp';rev++;
 assert.equal(bound.isCurrent(),false);assert.equal(registry.get('s','server','a'),null);
 assert.equal(registry.establishVerified('s','server','a'),true);const replacement=registry.get('s','server','a');
 authority.retireSession('s');assert.equal(replacement.isCurrent(),false);
});
