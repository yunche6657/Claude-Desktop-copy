import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {stageDeploymentRuntime,verifyDeploymentRuntime}=require('../build/gateway-runtime.cjs');
function fixture(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-deploy-'));const root=path.join(base,'source'),out=path.join(base,'out');fs.mkdirSync(path.join(root,'.data'),{recursive:true});t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return{root,out,file:path.join(root,'.data/gateway-runtime.json')};}
test('release stages only validated nonsecret settings outside app.asar',t=>{const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({version:1,rules:[{baseURL:'http://127.0.0.1:3000/',model:'m',adapter:'system-first',systemContextPrefix:'System context:\n'}]}));const r=stageDeploymentRuntime(f.root,f.out);assert.equal(r.credentialsBundled,false);const p=JSON.parse(fs.readFileSync(path.join(f.out,r.file),'utf8'));assert.equal(p.rules[0].baseURL,'http://127.0.0.1:3000');assert.equal(p.rules[0].adapter,'system-first');assert.equal(r.sha256.length,64);});
test('absent settings are not created and forbidden credential fields never get deployed',t=>{const f=fixture(t);assert.equal(stageDeploymentRuntime(f.root,f.out),null);fs.writeFileSync(f.file,JSON.stringify({version:1,rules:[{baseURL:'https://example.invalid',model:'m',adapter:'none',apiKey:'must-not-copy'}]}));assert.throws(()=>stageDeploymentRuntime(f.root,f.out),/Invalid gateway runtime/);assert.equal(fs.existsSync(path.join(f.out,'resources/gateway-runtime.json')),false);});

test('release verification refuses an unrequested rule file when no source configuration exists',t=>{const f=fixture(t);assert.equal(verifyDeploymentRuntime(f.root,f.out),null);fs.mkdirSync(path.join(f.out,'resources'),{recursive:true});fs.writeFileSync(path.join(f.out,'resources/gateway-runtime.json'),JSON.stringify({version:1,rules:[]}));assert.throws(()=>verifyDeploymentRuntime(f.root,f.out),/Unexpected deployment/);});
