import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import vm from 'node:vm';
const require=createRequire(import.meta.url);const {createConsentTargetExtractor}=require('../desktop/hybrid-bootstrap-consent-targets.cjs');
const source=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');const fragment=source.slice(source.indexOf('function uLe('),source.indexOf('function mLe(',source.indexOf('function uLe(')));assert.ok(fragment.includes('function pLe('));
const registry={top:['command','endpoint','disabled','empty'],all:['nested','servers']};const schemas={nested:new Set(['command','auth.helper']),servers:new Set(['command','env.KEY'])};
const stable=value=>JSON.stringify(value);const dependencies={consentKeys:()=>registry.top,allKeys:()=>registry.all,isFailClosed:(key,value)=>key==='disabled'&&value===false,isUrlField:key=>key==='endpoint',nestedPaths:key=>schemas[key]??new Set(),formerLabel:key=>key==='command'?'commandLegacy':undefined,serialize:stable};
const sandbox={wAe:dependencies.formerLabel,es:stable,lFe:()=>registry.top,Yc:()=>registry.all,yFe:dependencies.isFailClosed,eTe:node=>node==='endpoint',Bc:{shape:{endpoint:'endpoint',nested:'nested',servers:'servers'}},pTe:node=>schemas[node]??new Set(),URL};vm.createContext(sandbox);vm.runInContext(fragment,sandbox);
const canonical=value=>JSON.parse(JSON.stringify(value));
test('upstream pLe VM differential: fail closed, former label, origin, nested and duplicate array entries',()=>{
 const input={command:'tool',endpoint:'https://example.test/path',disabled:false,empty:[],nested:{command:'run',auth:{helper:'helper'},ignored:9},servers:[{name:'same',command:'one',env:{KEY:'A'}},{name:'same',command:'two'},{repo:'repo',command:'three'},{url:'https://a.test',command:'four'},{command:'five'}]};
 const actual=createConsentTargetExtractor(dependencies)(input), expected=sandbox.pLe(input);assert.deepEqual(canonical(actual),canonical(expected));assert.equal(actual.find(x=>x.label==='servers[same]#2').entryIndex,1);assert.equal(actual.find(x=>x.label==='endpoint').origin,'https://example.test');
});
test('empty or missing inputs yield no targets, and invalid URL follows native throwing behavior',()=>{
 const extract=createConsentTargetExtractor(dependencies);assert.deepEqual(canonical(extract({})),canonical(sandbox.pLe({})));assert.throws(()=>extract({endpoint:'not-url'}),TypeError);assert.throws(()=>sandbox.pLe({endpoint:'not-url'}));
});
