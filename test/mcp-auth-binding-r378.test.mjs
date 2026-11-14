import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { createMcpAuthBindingRegistry, validateBindingUrl } = createRequire(import.meta.url)('../desktop/mcp-auth-binding.cjs');

function fixture() {
  let actor = { actorToken:'a', generation:1 }, live = true, url = 'https://example.test/mcp/';
  const proof = () => ({url, isCurrent:() => live});
  const registry = createMcpAuthBindingRegistry({getActor:() => actor, issueVerified:proof, issueConfigAuth:proof});
  return {registry, actor, changeActor:(a,g) => { actor={actorToken:a,generation:g}; }, invalidate:() => {live=false;}, setUrl:u => {url=u;}};
}
test('none, trusted sources, revocation and source freshness are bound to actor generation', () => {
  const f=fixture(), r=f.registry, none=r.get('s','server','a');
  assert.equal(none.kind,'none');
  assert.equal(r.establishVerified('s','server','a'),true);
  assert.equal(none.isCurrent(),false);
  const v=r.get('s','server','a'); assert.equal(v.kind,'verified'); assert.equal(v.url,'https://example.test/mcp/');
  assert.equal(r.establishConfigAuth('s','server','a'),true); assert.equal(v.isCurrent(),false);
  const c=r.get('s','server','a'); assert.equal(c.kind,'config-auth');
  assert.equal(r.completeReconnect('other','server','a',c),false);
  assert.equal(r.completeReconnect('s','server','a',c),true);
  assert.equal(c.isCurrent(),false); assert.equal(r.get('s','server','a').kind,'none');
  assert.equal(r.establishVerified('s','server','a'),true); const old=r.get('s','server','a');
  f.invalidate(); assert.equal(old.isCurrent(),false); assert.equal(r.get('s','server','a'),null);
  f.changeActor('b',2); assert.equal(r.get('s','server','a'),null); assert.equal(r.get('s','server','b').kind,'none');
  assert.equal(old.isCurrent(),false);
});
test('no untrusted status or caller URL grants a binding; failure and reentrancy fail closed', () => {
  const r=createMcpAuthBindingRegistry({getActor:() => ({actorToken:'a',generation:1})});
  assert.equal(r.establishVerified('s','x','a','https://attacker.test'),false);
  assert.equal(r.establishConfigAuth('s','x','a',{url:'https://attacker.test'}),false);
  assert.equal(r.get('s','x','a').kind,'none');
  let rr;
  rr=createMcpAuthBindingRegistry({getActor:() => ({actorToken:'a',generation:1}),issueVerified:() => {
    rr.revoke('s','x','a'); return {url:'https://example.test',isCurrent:() => true};
  }});
  assert.equal(rr.establishVerified('s','x','a'),false); assert.equal(rr.get('s','x','a').kind,'none');
});
test('different sessions, servers, replaced actors and retirement invalidate old snapshots', () => {
  const f=fixture(),r=f.registry;
  r.establishVerified('s','x','a'); const v=r.get('s','x','a');
  r.revoke('s','y','a'); assert.equal(v.isCurrent(),true);
  const other=r.get('other','x','a'); r.retireSession('s'); assert.equal(v.isCurrent(),false); assert.equal(other.isCurrent(),true);
  const n=r.get('s','x','a'); f.changeActor('a',2); assert.equal(n.isCurrent(),false);
  assert.equal(r.get('s','x','a').kind,'none');
});
test('reset clears only config authentication and respects actor generation',()=>{
 const f=fixture(),r=f.registry;
 assert.equal(r.establishConfigAuth('s','x','a'),true);const config=r.get('s','x','a');
 assert.equal(r.resetConfigAuth('s','x','a',2),false);assert.equal(config.isCurrent(),true);
 assert.equal(r.resetConfigAuth('s','x','a',1),true);assert.equal(config.isCurrent(),false);assert.equal(r.get('s','x','a').kind,'none');
 assert.equal(r.establishVerified('s','x','a'),true);const verified=r.get('s','x','a');
 assert.equal(r.resetConfigAuth('s','x','a',1),false);assert.equal(verified.isCurrent(),true);
 f.invalidate();assert.equal(verified.isCurrent(),false);assert.equal(r.resetConfigAuth('s','x','a',1),false);
});
test('URL comparisons match shipped verifyPluginMcpBinding in isolated VM', async () => {
  const source=fs.readFileSync('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js','utf8');
  const lza=fs.readFileSync('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js','utf8');
  const norm=lza.slice(lza.indexOf('function XTe('),lza.indexOf('function ls(',lza.indexOf('function XTe(')));
  const native=vm.runInNewContext(`(()=>{${norm};let t={o8:XTe,L5:{warn(){},error(){}},M4:String};let zA=Symbol('timeout'), fx=(_s,_q,p)=>p;${source.slice(source.indexOf('async function bj('),source.indexOf('var xj=class',source.indexOf('async function bj(')))};return bj})()`, {URL});
  for (const kind of ['verified','config-auth']) for (const [expected,actual] of [
    ['https://EXAMPLE.test:443/mcp/','https://example.test/mcp'], ['https://example.test/mcp?x=1','https://example.test/mcp?x=2'],
    ['https://example.test/a','https://example.test/b'],['','https://example.test/'],['https://example.test/',''],['bad','bad']]) {
    const session={backend:{kind:'local'},query:{mcpServerStatus:async()=>[{name:'x',config:{url:actual}}]},configMcpAuthServers:kind==='config-auth'?new Set(['x']):new Set()};
    assert.equal(validateBindingUrl(expected,actual,kind),await native(session,'x',expected));
  }
});
