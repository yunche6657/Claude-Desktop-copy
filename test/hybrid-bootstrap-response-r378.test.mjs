import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createBootstrapResponseValidator}=require('../desktop/hybrid-bootstrap-response.cjs');
test('response wrapper matches native Dtn and preserves hybrid origin rules',()=>{
 const source=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');let a=source.indexOf('function Dtn('),b=source.indexOf('async function Otn(',a);assert.ok(a>0&&b>a);
 let nativeArgs,oursArgs,caseData;const fakeIntake=(json,origin,_log,_keys,opts)=>{nativeArgs={origin,opts};return caseData};const sandbox={iLe:fakeIntake,ou:{},a:{app:{isPackaged:true}},N:{debug(){},warn(){},info(){}},Xx:{crossOriginDropped:'',overlaySupplied:''},jo:()=>false,lRe:errors=>errors.some(e=>e.otherTarget),nLe:()=> 'bad'};
 const native=vm.runInNewContext(`${source.slice(a,b)};Dtn`,sandbox);
 const ours=createBootstrapResponseValidator({intake:(json,origin,opts)=>{oursArgs={origin,opts};return caseData},hasNonDesktopFailure:e=>e.some(x=>x.otherTarget),describeFailure:()=> 'bad'});
 for(const hybrid of [true,false])for(const oidc of [undefined,{issuer:'fixture'}])for(const data of [{config:{expiresAt:5},rejected:[],warnings:[],keyedParseErrors:[]},{config:{expiresAt:5},rejected:[],warnings:[],keyedParseErrors:[{key:'remote',otherTarget:true}]},{config:{key:'value'},rejected:[],warnings:['warn'],keyedParseErrors:[]}]){
 caseData=data;let input={json:{},bootstrapUrl:'https://example.test/bootstrap',trustedOrigin:'https://example.test',oidc,hybrid,trustedDelivery:true,now:123,etag:'tag',respStatus:200};let expected=native(input),actual=ours(input);assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(expected)));assert.equal(oursArgs.origin,nativeArgs.origin);assert.equal(oursArgs.opts.channel,nativeArgs.opts.channel);assert.equal(oursArgs.opts.allowLoopbackResponseUrls,nativeArgs.opts.allowLoopbackResponseUrls);
 }
});
