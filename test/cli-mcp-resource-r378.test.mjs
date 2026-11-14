import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {parseCliMcpResourceReply,readCliMcpResource}=require('../desktop/cli-mcp-resource.cjs');
const main=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const helper=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-M6SkuaH9.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js',import.meta.url),'utf8');
const cut=(s,a,b)=>{const i=s.indexOf(a),j=s.indexOf(b,i);assert.ok(i>=0&&j>i);return s.slice(i,j)};
const z=vm.runInNewContext(`${cut(main,'function Pe(e)','var Hn=')};({h9:D,d9:j,c9:Nn,o9:Bn,r9:A,_9:An,p9:Ln})`);
const schema=vm.runInNewContext(`${cut(helper,'var Nn="ui://"','function Rn(')};Ln`,{t:z});
const meta=vm.runInNewContext(`${cut(helper,'var Un=new Set(', 'function Kn(')};Gn`);
const native=vm.runInNewContext(`var jA=10485760;${cut(app,'function NA()', 'function LA(')};IA`,{n:{uu:schema,lu:meta},t:{GQ:{ReadFailed:'read_failed'},L5:{warn(){}},M1:p=>p},de:{t:()=>''}});
const serial=value=>JSON.stringify(value);
test('resource parser and metadata match original IA with real shipped Zod',async()=>{
 const inputs=[
  {contents:[{uri:'ui://one',mimeType:'text/html',text:'hi',unused:9,_meta:{ui:{resourceUri:'ui://a',visibility:['app'],prefersBorder:true,csp:{connectDomains:['x']},other:42},'ui/resourceUri':'ui://old',other:'x'}}]},
  {contents:[{uri:'x',blob:'a',_meta:{ui:{csp:'unsafe',prefersBorder:3},'ui/resourceUri':null}}]},
  {contents:[{uri:'x',_meta:{ui:['a','b'],other:'removed'}}]},
  {contents:[{uri:'x',_meta:new Date()}]},
  {contents:[]}, {contents:[{uri:'x',text:3}]}, {contents:[{uri:'x',_meta:null}]}, {contents:[{uri:'x',_meta:[]}]}, {contents:[{uri:'x',mimeType:null}]}, {contents:[{}]}, {contents:'wrong'}, null,
  {contents:[{uri:'x',text:'字'.repeat(10485760)}]},
 ];
 for(const input of inputs) for(const user of [false,true]) {
  const actual=parseCliMcpResourceReply(input,user);
  const expected=await native({readMcpResource:async()=>input},'server','ui://view',promise=>promise,user);
  assert.equal(serial(actual),serial(expected));
 }
});
test('read checks URI and maps rejected control requests to read_failed',async()=>{
 let calls=0;
 assert.deepEqual(await readCliMcpResource({uri:'https://wrong',read:()=>{calls++;}}),{contents:[],unavailable:'read_failed'});
 assert.equal(calls,0);
 assert.deepEqual(await readCliMcpResource({uri:'ui://view',serverName:'s',read:()=>Promise.reject(Error('offline'))}),{contents:[],unavailable:'read_failed'});
 const reply={contents:[{uri:'ui://x',text:'ok'}]};
 assert.deepEqual(await readCliMcpResource({uri:'ui://view',serverName:'s',read:(name,uri)=>{assert.equal(name,'s');assert.equal(uri,'ui://view');return reply;}}),reply);
});
test('unanswered CLI resource request expires after 30 seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=readCliMcpResource({uri:'ui://view',serverName:'s',read:()=>new Promise(()=>{})});
 t.mock.timers.tick(30000);
 assert.deepEqual(await pending,{contents:[],unavailable:'read_failed'});
});
