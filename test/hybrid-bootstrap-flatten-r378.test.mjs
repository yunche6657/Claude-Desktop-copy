import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {flattenBootstrap}=require('../desktop/hybrid-bootstrap-flatten.cjs');
const source=readFileSync(resolve('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js'),'utf8');
const a=source.indexOf('function KIe('), b=source.indexOf('function nLe(',a);assert.ok(a>=0&&b>a);
const clusterNames=['telemetry','builtinBrowser','unimplemented'];
const entries={telemetry:{propMap:{disableEssential:'disableEssentialTelemetry'},flatten:x=>x.disableEssential===undefined?{}:{disableEssentialTelemetry:x.disableEssential},findUnread:x=>Object.keys(x).filter(k=>k!=='disableEssential').map(k=>`telemetry.${k}`)},builtinBrowser:{propMap:{'domain.enabled':'flag'},flatten:x=>x.domain?.enabled===undefined?{}:{flag:x.domain.enabled},findUnread:()=>[]}};
const al={...entries,unimplemented:{propMap:{},flatten:x=>x}};
const native=runInNewContext(`${source.slice(a,b)};tLe`,{al,IIe:clusterNames,Pc:{shape:{}},QMe:(name,_schema,obj,cb)=>{for(const item of entries[name]?.findUnread?.(obj)??[])cb(null,null,item)}});
function compare(input){const expected=native(input),actual=flattenBootstrap(input,{clusterNames,clusters:entries});assert.deepEqual(actual.flat,JSON.parse(JSON.stringify(expected.flat)));assert.equal(actual.version,expected.version);assert.deepEqual(actual.warnings,Array.from(expected.warnings));assert.deepEqual(actual.unread,Array.from(expected.unread));assert.deepEqual(actual.unresolved,[])}
test('version selection, v1 passthrough and v2 cluster dispatch match native tLe',()=>{
 for(const x of [{$schemaVersion:1,telemetry:{disableEssential:true},extra:9}, {telemetry:{disableEssential:false,other:4},extra:7}, {$schemaVersion:2,telemetry:'{"disableEssential":true}'},{$schemaVersion:7,builtinBrowser:{domain:'{"enabled":true}'},flag:false},{$schemaVersion:2,telemetry:[]},{$schemaVersion:2,builtinBrowser:{domain:'bad'}}]) compare(x);
});
test('unimplemented clusters stay visible and are explicitly unresolved',()=>{const x=flattenBootstrap({unimplemented:{opaque:true}},{clusterNames,clusters:entries});assert.deepEqual(x.flat,{unimplemented:{opaque:true}});assert.deepEqual(x.unresolved,['unimplemented'])});

test('actual builtinBrowser cluster maps all four shipped properties like original MIe',()=>{
 const {BUILTIN_BROWSER_MAP,BUILTIN_BROWSER_CLUSTER}=require('../desktop/hybrid-bootstrap-flatten.cjs');
 const start=source.indexOf('function AIe('),end=source.indexOf(',NIe=',start);assert.ok(start>=0&&end>start);
 const pairs=Object.entries(BUILTIN_BROWSER_MAP).map(([key,target])=>[[key],target]);
 const make=runInNewContext(`${source.slice(start,end)};MIe`,{kIe:()=>pairs});
 const upstream=make({});
 const cases=[{}, {enabled:true,defaultDomainPolicy:'block',allowedDomains:['example.com'],blockedDomains:['*']}, {enabled:null,unknown:'unread'}, {enabled:false,allowedDomains:[]}];
 for(const value of cases){
  assert.deepEqual(BUILTIN_BROWSER_CLUSTER.flatten(value),JSON.parse(JSON.stringify(upstream.flatten(value))));
  const opts={clusterNames:['builtinBrowser'],clusters:{builtinBrowser:BUILTIN_BROWSER_CLUSTER}};
  const actual=flattenBootstrap({builtinBrowser:value},opts);
  const vm=runInNewContext(`${source.slice(a,b)};tLe`,{al:{builtinBrowser:upstream},IIe:['builtinBrowser'],Pc:{shape:{}},QMe:(_name,_schema,object,cb)=>{for(const key of Object.keys(object))if(!Object.hasOwn(BUILTIN_BROWSER_MAP,key)&&object[key]!==undefined)cb(null,null,`builtinBrowser.${key}`)}});
  const expected=vm({builtinBrowser:value});
  assert.deepEqual(actual.flat,JSON.parse(JSON.stringify(expected.flat)));
  assert.deepEqual(actual.unread,Array.from(expected.unread));
 }
});

test('actual telemetry cluster maps all five shipped properties like original MIe',()=>{
 const {TELEMETRY_MAP,TELEMETRY_CLUSTER}=require('../desktop/hybrid-bootstrap-flatten.cjs');
 const start=source.indexOf('function AIe('),end=source.indexOf(',NIe=',start);assert.ok(start>=0&&end>start);
 const schemaStart=source.indexOf('RMe=j({'),schemaEnd=source.indexOf('zMe=',schemaStart);
 assert.ok(schemaStart>=0&&schemaEnd>schemaStart);
 const schema=source.slice(schemaStart,schemaEnd);
 for(const [key,target] of Object.entries(TELEMETRY_MAP)) assert.match(schema,new RegExp(`${key}:U\\([\\s\\S]{0,500}?flatKey:"${target}"`));
 const pairs=Object.entries(TELEMETRY_MAP).map(([key,target])=>[[key],target]);
 const upstream=runInNewContext(`${source.slice(start,end)};MIe`,{kIe:()=>pairs})({});
 const vm=runInNewContext(`${source.slice(a,b)};tLe`,{al:{telemetry:upstream},IIe:['telemetry'],Pc:{shape:{}},QMe:(_name,_schema,object,cb)=>{for(const key of Object.keys(object))if(!Object.hasOwn(TELEMETRY_MAP,key)&&object[key]!==undefined)cb(null,null,`telemetry.${key}`)}});
 for(const value of [{},{orgUuid:'abc',disableEssential:true,disableNonessential:false,disableNonessentialServices:true,usageMetrics:false},{orgUuid:null,other:1}, {disableEssential:false,usageMetrics:undefined}]){
  assert.deepEqual(TELEMETRY_CLUSTER.flatten(value),JSON.parse(JSON.stringify(upstream.flatten(value))));
  const actual=flattenBootstrap({telemetry:value},{clusterNames:['telemetry'],clusters:{telemetry:TELEMETRY_CLUSTER}});
  const expected=vm({telemetry:value});
  assert.deepEqual(actual.flat,JSON.parse(JSON.stringify(expected.flat)));
  assert.deepEqual(actual.unread,Array.from(expected.unread));
 }
});
