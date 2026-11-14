import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {coerceManagedBoolean,parseManagedJson,coerceManagedInput}=createRequire(import.meta.url)('../desktop/windows-managed-coercion.cjs');
const source=fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const slice=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start);return source.slice(start,end)};
const native=vm.runInNewContext(slice('function OFe(', 'function kFe(')+slice('function WMe(', ',KMe=')+';({OFe,GMe,WMe})');
const plain=value=>JSON.stringify(value);
test('managed boolean coercion matches original including zero and invalid values',()=>{
 for(const value of [undefined,null,false,true,0,1,-1,2,NaN,'  TRUE\r ','false','1','0','yes','',[],{}]) assert.equal(coerceManagedBoolean(value),native.OFe(value),String(value));
});
test('managed JSON recovery and scalar preservation match original',()=>{
 for(const value of ['{"path":"C:\\work\\folder"}','{"path":"C:\\new"}','[1,2]','true','42','null','not json','{"broken":}',42,null,{a:1}]) {
  assert.equal(plain(parseManagedJson(value)),plain(native.GMe(value)),String(value));
  assert.equal(coerceManagedInput('string',value),value);
  assert.equal(coerceManagedInput('enum',value),value);
  assert.equal(plain(coerceManagedInput('object',value)),plain(native.GMe(value)));
 }
});
