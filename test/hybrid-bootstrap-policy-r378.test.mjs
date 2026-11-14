import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {applyBootstrapUrlPolicy}=require('../desktop/hybrid-bootstrap-policy.cjs');
const bundle=readFileSync(resolve('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js'),'utf8');
function extract(start,end){const a=bundle.indexOf(start),b=bundle.indexOf(end,a);assert.ok(a>=0&&b>a);return bundle.slice(a,b)}
const source=extract('function aLe(', 'function uLe(')+extract('function mLe(', 'var vLe=')+extract('function oEe(', 'var sEe=');
const metadata={url:{remotePolicy:{rejectLoopback:true},failClosedValue:'closed'}, pinned:{remotePolicy:{originPinned:{}}}, only:{remotePolicy:{hybrid:{scope:'only'}}}, exception:{remotePolicy:{rejectLoopback:true,hybrid:{loopback:true}}}};
function original(input,options){
 const map={...input}, stood=[];
 const run=runInNewContext(`${source};aLe`,{URL,ps:new Set(['127.0.0.1','localhost','[::1]']),Yc:()=>Object.keys(metadata),Uc:k=>metadata[k], Zc:(out,k,cb)=>{if(Object.hasOwn(metadata[k],'failClosedValue')){out[k]=metadata[k].failClosedValue;cb?.()}},Ps:()=>false,oDe:()=>[]});
 const rejected=run(map,{...options,onFailClosed:k=>stood.push(k)});
 return {config:map,rejected:Array.from(rejected),stoodIn:stood};
}
test('original aLe and helpers agree on origin, hybrid-only and fail-closed URL rules',()=>{
 const cases=[
 [{url:'http://example.com',pinned:'https://other.example/a',only:true},{channel:'bootstrap',trustedOrigin:'https://origin.example'}],
 [{url:'https://sub.localhost',exception:'http://127.0.0.1/a',only:true},{channel:'hybrid',trustedOrigin:undefined}],
 [{url:'https://[::ffff:7f00:1]/',exception:'http://127.0.0.2/'},{channel:'hybrid'}],
 [{url:'https://example.com',pinned:'https://origin.example/x'},{channel:'bootstrap',trustedOrigin:'https://origin.example'}],
 [{url:'http://localhost',exception:'http://localhost'},{channel:'bootstrap',allowLoopbackResponseUrls:true}],
 ];
 for(const [input,opts] of cases){const actual=applyBootstrapUrlPolicy(input,{...opts,metadata}),expected=original(input,opts);assert.deepEqual(actual.config,expected.config);assert.deepEqual(actual.rejected,expected.rejected);assert.deepEqual(actual.stoodIn,expected.stoodIn);}
});
test('local and mdm bypass URL source policy',()=>{for(const channel of ['local','mdm'])assert.equal(applyBootstrapUrlPolicy({url:'http://localhost'},{metadata,channel}).config.url,'http://localhost')});

test('MCP and marketplace cleaning matches directly extracted original aLe',()=>{
 const defs={mcp:{remotePolicy:{mcpUrlHygiene:true},failClosedValue:[]},market:{remotePolicy:{marketplaceUrlHygiene:true}}};
 const originalRun=runInNewContext(`${source};aLe`,{URL,ps:new Set(['127.0.0.1','localhost','[::1]']),Yc:()=>Object.keys(defs),Uc:k=>defs[k],Zc:(out,k,cb)=>{if(Object.hasOwn(defs[k],'failClosedValue')){out[k]=defs[k].failClosedValue;cb?.()}},Ps:item=>item.builtin===true,oDe:oauth=>oauth?.endpoints??[]});
 for(const input of [
  {mcp:[{name:'good',transport:'sse',url:'https://example.com'},{name:'bad',transport:'sse',url:'http://localhost'}],market:[{url:'https://example.com'},{url:'http://localhost'},null]},
  {mcp:[{name:'bad',transport:'sse',url:'https://ok.example',oauth:{endpoints:['http://localhost']}}],market:[{url:'http://localhost'}]},
 ]) {
  const expected=structuredClone(input);originalRun(expected,{channel:'bootstrap'});
  const actual=applyBootstrapUrlPolicy(input,{metadata:defs,isBuiltinMcp:item=>item.builtin===true,oauthUrls:oauth=>oauth?.endpoints??[]});
  assert.deepEqual(actual.config,JSON.parse(JSON.stringify(expected)));
 }
});

