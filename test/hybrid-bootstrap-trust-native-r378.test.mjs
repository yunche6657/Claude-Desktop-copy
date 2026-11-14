import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {isControlPlaneUrl, trustedBootstrapDelivery} = createRequire(import.meta.url)('../desktop/hybrid-bootstrap-trust.cjs');
const text=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
function extract(start,end){const a=text.indexOf(start),b=text.indexOf(end,a);assert.ok(a>=0&&b>a);return text.slice(a,b)}
const source=extract('function ZCe(', 'var So=')+extract('function MTe(', 'function NTe(')+extract('function rBe(', 'function kl(')+extract('function mtn(', 'var jw=');
function original({config,rawConfig,serverUrlDeviceDelivered,isPackaged,developmentUrl}) {
 const context={URL, Yze:new Set(['api.anthropic.com','api-staging.anthropic.com','api.claude.ai']),a:{app:{isPackaged}},process:{env:{CLAUDE_HYBRID_BOOTSTRAP_URL:developmentUrl}},K:()=>config,NWe:()=>rawConfig,IWe:()=>serverUrlDeviceDelivered};
 return vm.runInNewContext(source+';({Ol,mtn})',context);
}
test('control-plane host and trusted delivery match original functions across provenance and URL cases',()=>{
 const urls=['https://api.anthropic.com/a','http://api.claude.ai/a','https://api.anthropic.com:444/a','https://user@api.anthropic.com/','https://api.anthropic.com\\@evil.test','https://other.invalid/path','not a url','https://DEV.example/path'];
 for(const isPackaged of [true,false]) for(const trust of [undefined,false,true]) for(const device of [false,true]) for(const url of urls) {
  const opts={config:{bootstrap:{url}},rawConfig:{bootstrap:{trustBootstrapDelivery:trust}},serverUrlDeviceDelivered:device,isPackaged,developmentUrl:' https://dev.example/base '};
  const native=original(opts);
  assert.equal(isControlPlaneUrl(url,opts),native.Ol(url),`host: ${url}`);
  assert.equal(trustedBootstrapDelivery(url,opts),native.mtn(url),`delivery: ${url}`);
  assert.equal(trustedBootstrapDelivery(url+'?other',opts),native.mtn(url+'?other'),`changed URL: ${url}`);
 }
});
