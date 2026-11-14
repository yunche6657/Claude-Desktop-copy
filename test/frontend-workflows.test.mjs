import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),project=path.resolve(import.meta.dirname,'..');
test('renderer rebuild removes stale output and produces stable inventory',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'renderer-build-'));
 try{fs.mkdirSync(path.join(root,'tools'));fs.cpSync(path.join(project,'renderer'),path.join(root,'renderer'),{recursive:true});fs.copyFileSync(path.join(project,'tools/build-frontend.cjs'),path.join(root,'tools/build-frontend.cjs'));
 const run=()=>{const r=spawnSync(process.execPath,[path.join(root,'tools/build-frontend.cjs')],{windowsHide:true,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};run();const manifest=fs.readFileSync(path.join(root,'dist/frontend/build-manifest.json'),'utf8');fs.writeFileSync(path.join(root,'dist/frontend/stale.txt'),'obsolete');run();assert.equal(fs.existsSync(path.join(root,'dist/frontend/stale.txt')),false);assert.equal(fs.readFileSync(path.join(root,'dist/frontend/build-manifest.json'),'utf8'),manifest);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('frontend validation rejects tampered and uninventoried assets',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frontend-check-'));const {check}=require('../tools/check-frontend.cjs');const crypto=require('crypto');
 try{const res=path.join(root,'resources'),dir=path.join(res,'ion-dist');fs.mkdirSync(dir,{recursive:true});const html='<html></html>';fs.writeFileSync(path.join(dir,'index.html'),html);fs.writeFileSync(path.join(res,'frontend-manifest.json'),JSON.stringify({files:[{path:'index.html',size:html.length,sha256:crypto.createHash('sha256').update(html).digest('hex')}]}));fs.writeFileSync(path.join(res,'bootstrap-3p.json'),JSON.stringify({account:{},growthbook:{features:{}},model_selector_config:{}}));assert.equal(check(root).files,1);fs.writeFileSync(path.join(dir,'extra.js'),'');assert.throws(()=>check(root),/Uninventoried/);fs.unlinkSync(path.join(dir,'extra.js'));fs.writeFileSync(path.join(dir,'index.html'),'tampered');assert.throws(()=>check(root),/digest mismatch/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
