import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {buildBootstrap}=require('../desktop/bootstrap-service.cjs');
test('bootstrap selector follows explicit startup model without mutating its caller environment',()=>{
 const env={ANTHROPIC_BASE_URL:'https://active.example',CLAUDE_AGENT_MODEL:'explicit-startup-model'},before={...env};
 const p=buildBootstrap({env,resolveGateway:()=>({baseUrl:'https://old.example',model:'old-profile-model',apiKey:'old-profile-secret'})});
 assert.ok(p.model_selector_state.every(row=>row.model==='explicit-startup-model'));assert.deepEqual(env,before);
});
test('bootstrap and native startup share the unique workspace runtime model',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'.data'));fs.writeFileSync(path.join(root,'.data/gateway-runtime.json'),JSON.stringify({version:1,rules:[{baseURL:'https://active.example',model:'runtime-only-model',adapter:'none'}]}));
 const env={CLAUDE_WORKSPACE:root,ANTHROPIC_BASE_URL:'https://active.example'};
 const p=buildBootstrap({env,resolveGateway:()=>({baseUrl:'https://active.example',model:'',apiKey:'fixture-key'})});
 assert.ok(p.model_selector_state.every(row=>row.model==='runtime-only-model'));assert.equal(env.CLAUDE_AGENT_MODEL,undefined);
});
