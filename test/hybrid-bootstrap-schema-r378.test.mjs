import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {FIELD_METADATA,parseBootstrapSchema}=require('../desktop/hybrid-bootstrap-schema.cjs');
const bundle=readFileSync(resolve('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js'),'utf8');
function extract(start,end){const a=bundle.indexOf(start),b=bundle.indexOf(end,a);assert.ok(a>=0&&b>a);return bundle.slice(a,b)}
const booleanSource=extract('function OFe(', 'function kFe(');
const fieldSource=extract('function Zc(', 'var Qc=');
const native=runInNewContext(`${booleanSource}${fieldSource}; MFe`,{
 Uc:key=>FIELD_METADATA[key], Bc:{shape:{}}, Wo:()=>({}), Ho:()=>1, Bo:{ZodBoolean:1}
});
test('audited flat boolean fields agree with extracted native MFe / OFe',()=>{
 for(const key of Object.keys(FIELD_METADATA).filter(k=>!FIELD_METADATA[k].type))for(const value of [true,false,1,0,2,-1,'true',' FALSE ','1','0','no','',null,undefined,{},'true\r']) {
  const expected={},stood=[];native(expected,key,value,()=>{},{onFailClosed:()=>stood.push(key)});
  const actual=parseBootstrapSchema({[key]:value});
  assert.deepEqual(actual.config,expected,`${key} ${String(value)}`);
  assert.deepEqual(actual.stoodIn,stood,`${key} ${String(value)} stand-in`);
 }
});
test('unsupported fields cannot enter parsed config',()=>{
 const result=parseBootstrapSchema({unknown:true,bootstrap:{url:'https://example.invalid'},keepAwakeEnabled:'bad'});
 assert.deepEqual(result.config,{keepAwakeEnabled:false});
 assert.deepEqual(result.unsupported,['unknown','bootstrap']);
 assert.deepEqual(result.stoodIn,['keepAwakeEnabled']);
});

test('native MFe differential for actual string and enum fields',()=>{
 const cases={deploymentOrganizationUuid:['abc',' UUID ',1,true,{},null,''],builtinBrowserDefaultDomainPolicy:['allow','block','ALLOW','',42,null]};
 for(const [key,values] of Object.entries(cases))for(const value of values){
  const type=FIELD_METADATA[key].type;
  const validator={safeParse:x=> type==='string' ? (typeof x==='string'?{success:true,data:x}:{success:false,error:{issues:[{code:'invalid_type',path:[]}]}}) : (FIELD_METADATA[key].values.includes(x)?{success:true,data:x}:{success:false,error:{issues:[{code:'invalid_value',path:[],values:FIELD_METADATA[key].values}]}})};
  const original=runInNewContext(`${extract('function OFe(', 'function kFe(')}${extract('function kFe(', 'function Zc(')}${fieldSource};MFe`,{
   Uc:k=>FIELD_METADATA[k],Bc:{shape:{[key]:validator}},Wo:x=>x,Ho:()=>type==='string'?2:3,Bo:{ZodBoolean:1,ZodString:2,ZodEnum:3},GMe:x=>x,QMe:()=>{},VFe:()=>{},zFe:()=>[],NFe:x=>Array.isArray(x)?x.length:typeof x==='object'&&x?Object.keys(x).length:-1
  });
  const expected={},stood=[];original(expected,key,value,()=>{},{onFailClosed:()=>stood.push(key)});
  const actual=parseBootstrapSchema({[key]:value});assert.deepEqual(actual.config,expected,`${key} ${String(value)}`);assert.deepEqual(actual.stoodIn,stood);
 }
});


test('domain-list schema agrees with extracted native EPe, Do and MFe',()=>{
 const hostStart=bundle.indexOf('Cwe=/'),hostEnd=bundle.indexOf('function Dwe(',hostStart);
 const epStart=bundle.indexOf('function EPe('),epEnd=bundle.indexOf('var OPe=',epStart);
 assert.ok(hostStart>=0&&hostEnd>hostStart&&epStart>=0&&epEnd>epStart);
 const helpers=`var ${bundle.slice(hostStart,hostEnd)}${bundle.slice(epStart,epEnd)}`;
 const native=runInNewContext(`${helpers}${extract('function OFe(', 'function kFe(')}${extract('function kFe(', 'function Zc(')}${fieldSource}; ({MFe,EPe})`,{
  Uc:k=>FIELD_METADATA[k],Bc:{shape:{}},Wo:x=>x,Ho:()=>4,Bo:{ZodBoolean:1,ZodString:2,ZodEnum:3},
  GMe:x=>{if(typeof x!=='string')return x;try{return JSON.parse(x)}catch{return x}},
  QMe:()=>{},VFe:()=>{},zFe:()=>[],NFe:x=>Array.isArray(x)?x.length:-1
 });
 for(const key of ['builtinBrowserAllowedDomains','builtinBrowserBlockedDomains'])for(const value of [[],['*'],['',null,1],['localhost','EXAMPLE.COM','bad/host'],['a.example','*'],['a.example:65535','a.example:65536'],JSON.stringify(['a.example','']),JSON.stringify(['*']),'invalid',Array(501).fill('a.example')]){
  const kind=FIELD_METADATA[key].listKind;
  const validator={safeParse:x=>Array.isArray(x)?{success:true,data:x.filter(item=>native.EPe(kind,item)?.kind!=='drop')}:{success:false,error:{issues:[{code:'invalid_type',path:[]}]}}};
  const expected={},stood=[];native.MFe(expected,key,value,()=>{},{def:validator,onFailClosed:()=>stood.push(key)});
  const actual=parseBootstrapSchema({[key]:value});
  assert.deepEqual(actual.config,JSON.parse(JSON.stringify(expected)),`${key} ${JSON.stringify(value).slice(0,80)}`);assert.deepEqual(actual.stoodIn,stood);
 }
});

