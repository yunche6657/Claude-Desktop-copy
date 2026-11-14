import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {filterCliMcpApps}=require('../desktop/cli-mcp-app-filter.cjs');
const main=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const helper=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-M6SkuaH9.js',import.meta.url),'utf8');
const between=(source,start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b)};
const zod=vm.runInNewContext(`${between(main,'function Pe(e)','var Hn=')};({h9:D,d9:j,c9:Nn,o9:Bn,r9:A,_9:An})`);
const names=between(helper,'function Ne(', 'function Ke(');
const schemas=between(helper,'var Nn="ui://"', 'var Un=');
const native=vm.runInNewContext(`${names}${schemas};Hn`,{t:{...zod,kP:'remote-devices'}});
const plain=value=>JSON.stringify(value);
const item=(name='server',extra={})=>({name,source:'project',tools:[{name:'view',description:'desc',_meta:{ui:{resourceUri:'ui://panel',visibility:['app'],extra:'ok'},ignored:true}}],...extra});
test('host conflict injection is required',()=>{
 assert.throws(()=>filterCliMcpApps([]),/predicate required/);
});
test('original Hn and real shipped Zod match name, source, metadata and limits',()=>{
 const cases=[
   [item()], [item('plugin:A'),item('a')], [item('foo'),item('foobar')], [item('server',{source:'remote'})],
   [item('bad\nname')], [item('a'.repeat(129))], [item('x',{tools:null})], [item('x',{source:null})],
   [item('ok',{tools:[{name:'x',_meta:{'ui/resourceUri':'ui://page',unused:1}},{name:'v',_meta:{ui:{resourceUri:'https://bad'}}}]})],
   [item('ok',{tools:[{name:'x'.repeat(129),_meta:{'ui/resourceUri':'ui://x'}},{name:'valid',description:'x'.repeat(1100),_meta:{ui:{resourceUri:'ui://ok',arbitrary:{x:1}}}}]})],
   [item('ok',{tools:[{name:'x',_meta:{ui:{resourceUri:'ui://'+'a'.repeat(2044)}}}]})],
   Array.from({length:257},(_,i)=>item(`s${i}`)),
   [item('ok',{tools:Array.from({length:128},()=>({name:'bad\nname',_meta:{'ui/resourceUri':'ui://ok'}})).concat([{name:'last',_meta:{'ui/resourceUri':'ui://ok'}}])})],
   [item('ok',{tools:[{name:'bad\nname',_meta:{'ui/resourceUri':'ui://ok'}},{name:'valid',_meta:{ui:{resourceUri:'ui://ok'},'ui/resourceUri':'ui://legacy'}}]})],
   [new Date()], [item('ok',{tools:[new Date(),null,{}, {name:'valid',_meta:{ui:new Date(),'ui/resourceUri':'ui://ok'}}]})],
   [item('ok',{tools:[{name:'valid',_meta:{ui:{resourceUri:undefined},'ui/resourceUri':'ui://ok'}}]})],
   [item('ok',{tools:[{name:'valid',_meta:{ui:null,'ui/resourceUri':'ui://ok'}}]})],
 ];
 for (const input of cases) assert.equal(plain(filterCliMcpApps(input,()=>false)),plain(native(input,()=>false)));
 assert.equal(plain(filterCliMcpApps([item('owned')],name=>name==='owned')),plain(native([item('owned')],name=>name==='owned')));
});
test('host predicate and ambiguity follow original evaluation order',()=>{
 const input=[item('foo'),item('FOO'),item('valid'),item('invalid\nname'),item('ignored',{source:'remote'})];
 const expected=[],actual=[];
 const first=native(input,name=>(expected.push(name),false));
 const second=filterCliMcpApps(input,name=>(actual.push(name),false));
 assert.equal(plain(first),plain(second));
 assert.deepEqual(actual,expected);
 assert.deepEqual(actual,['foo','FOO','valid']);
});
