import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {createWindowsManagedTier}=createRequire(import.meta.url)('../desktop/windows-managed-tier.cjs');
const source=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const begin=source.indexOf('function DUe()'),end=source.indexOf('function OUe(',begin);
assert.ok(begin>=0&&end>begin);
const keyPath='SOFTWARE\\Policies\\Fixture', valueNames=['bootstrapUrl','trustBootstrapDelivery'];
function harness() {
  let records=[],entries=[],available=true; const originalLog=[],replicaLog=[];
  const reader={readRegistryValues:()=>records,enumRegistryValues:()=>entries};
  const base={bi:()=>available?reader:null,TUe:()=>{},EUe:()=>keyPath,gUe:()=>valueNames,wUe:(raw,failed=[])=>({raw,failed}),tUe:false,hu:false,wu:false,bUe:new Set(['Ignored']),_Ue:new Map([['bootstrapurl','bootstrapUrl'],['trustbootstrapdelivery','trustBootstrapDelivery']]),Cu:new Map([['bootstrapUrl','bootstrap.url'],['trustBootstrapDelivery','bootstrap.trust']]),mu:{add:key=>originalLog.push(['unreadable',key])},SUe:(_where,name)=>name==='OldName'?'deprecated':undefined,Su:value=>originalLog.push(['warning',value]),CUe:value=>`<${value}>`,xu:(_tier,msg,key)=>originalLog.push(['error',msg,...key===undefined?[]:[key]])};
  const ctx=vm.createContext(base); vm.runInContext(source.slice(begin,end),ctx);
  const replica=createWindowsManagedTier({reader:{readRegistryValues:(...a)=>reader.readRegistryValues(...a),enumRegistryValues:(...a)=>reader.enumRegistryValues(...a)},keyPath,valueNames,ignoredNames:base.bUe,canonicalNames:base._Ue,flatToConfigKey:base.Cu,parse:(raw,failed)=>({raw,failed}),classifyUnknown:base.SUe,formatUnknown:base.CUe,onWarning:value=>replicaLog.push(['warning',value]),onError:(msg,key)=>replicaLog.push(['error',msg,...key===undefined?[]:[key]]),onUnreadable:key=>replicaLog.push(['unreadable',key])});
  return {set:(r,e)=>{records=r;entries=e}, step:()=>{originalLog.length=0;replicaLog.length=0;ctx.hu=false;ctx.wu=false;const expected=ctx.DUe(),actual=replica.read();assert.deepEqual(JSON.parse(JSON.stringify(actual.values)),JSON.parse(JSON.stringify(expected)));assert.equal(actual.machineScoped,ctx.hu);assert.equal(actual.unknownValuesUnusable,ctx.wu);assert.equal(actual.readerAvailable,true);assert.deepEqual(replicaLog,originalLog);}};
}
const entry=(hive,name,value)=>({key:`${hive}\\${keyPath}\\${name}`,value});
test('Windows policy tier follows original HKCU, HKLM, unreadable and sticky machine selection',()=>{
 const h=harness();
 h.set([entry('HKCU','bootstrapUrl','https://user.invalid')],[]);h.step();
 h.set([entry('HKCU','bootstrapUrl','https://user.invalid'),entry('HKLM','bootstrapUrl','https://machine.invalid')],[{name:'bootstrapUrl'}]);h.step();
 h.set([entry('HKCU','bootstrapUrl','https://user.invalid')],[]);h.step();
});
test('Windows machine enumeration distinguishes unknown, recognized unreadable, deprecated and ignored names',()=>{
 for(const names of [['Other'],['bootstrapUrl'],['OldName'],['Ignored'],['Other','bootstrapUrl']]){
  const h=harness();h.set([],names.map(name=>({name})));h.step();
 }
});
test('missing native reader remains explicit for the host to resolve',()=>{
 const errors=[];
 const selector=createWindowsManagedTier({keyPath,valueNames,ignoredNames:new Set(),canonicalNames:new Map(),flatToConfigKey:new Map(),parse:()=>{throw new Error('unexpected parse')},classifyUnknown:()=>undefined,formatUnknown:String,onWarning:()=>{},onError:message=>errors.push(message),onUnreadable:()=>{}});
 assert.deepEqual(selector.read(),{values:{},machineScoped:false,unknownValuesUnusable:false,readerAvailable:false});
 assert.match(errors[0],/reader unavailable/);
});
