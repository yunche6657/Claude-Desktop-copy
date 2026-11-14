import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createHybridOidcStore}=require('../desktop/hybrid-oidc-store.cjs'),{createHybridOidcSession}=require('../desktop/hybrid-oidc-session.cjs');
test('foreground invalid grant deletes only selected encrypted slot',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hybrid-delete-r378-'));try{
 const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};const store=createHybridOidcStore({userData:dir,safeStorage});
 store.write('one',{accessToken:'',refreshToken:'old',clientId:'fixture',tokenUrl:'https://fixture.invalid'});store.write('two',{accessToken:'keep',refreshToken:'r'});
 const session=createHybridOidcSession({storage:store,fetch:async()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400})});const result=await session.getBootstrapBearer({storeKey:'one'},{background:false});assert.equal(result.kind,'auth');assert.equal(store.read('one'),undefined);assert.equal(store.read('two').accessToken,'keep');
 store.clearMemory();assert.equal(store.read('one'),undefined);assert.equal(store.read('two').accessToken,'keep');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('stale guarded delete preserves disk slot',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hybrid-delete-stale-r378-'));try{const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};const store=createHybridOidcStore({userData:dir,safeStorage});store.write('one',{accessToken:'keep'});let count=0;assert.equal(store.delete('one',{isCurrent:()=>++count===1}),false);store.clearMemory();assert.equal(store.read('one').accessToken,'keep');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
