import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { parseSubscription } = require('../desktop/subscription-import.cjs');
const { resolveConfig } = require('../desktop/agent-config.cjs');

test('subscription parser accepts token and Claude OAuth JSON with expiry normalization', () => {
  assert.equal(parseSubscription({input:'test-token'}).config.credentials.accessToken, 'test-token');
  const value = parseSubscription({input:JSON.stringify({claudeAiOauth:{accessToken:'test-token',refreshToken:'test-refresh',expiresAt:4102444800}}),name:'My subscription',model:'my-model'});
  assert.equal(value.config.credentials.expiresAt,4102444800000);
  assert.equal(value.config.inferenceModels[0].id,'my-model');
  assert.equal(value.name,'My subscription');
});

test('invalid credentials fail without echoing token text', () => {
  for (const input of ['', '{bad-secret', '[]', '{}', 'test secret']) {
    assert.throws(() => parseSubscription({input}));
  }
  assert.throws(() => parseSubscription({input:{accessToken:'secret',expiresAt:1}}), /已过期/);
});

test('bridge import persists a usable profile; invalid import leaves library intact', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subscription-import-'));
  const previous=process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA=root;
  try {
    const handlers=new Map();
    const {registerBridgeServices}=require('../desktop/bridge-services.cjs');
    registerBridgeServices({ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},bridgeMap:require('../desktop/shim/bridge-map.json'),settings:{dataDir:root},frontend:{root:process.cwd()},getMainWindow:()=>null});
    const call=(method,...args)=>{const key=[...handlers.keys()].find(key=>key.endsWith(`_$_Custom3pSetup_$_${method}`));assert.ok(key,method);return handlers.get(key)({},...args)};
    const bad=await call('importSubscription',{input:'{}'});
    assert.equal(bad.ok,false);
    assert.equal((await call('listConfigs')).entries.length,0);
    const result=await call('importSubscription',{input:'fixture-token',name:'Subscription',model:'fixture-model'});
    assert.equal(result.ok,true);
    const read=await call('readConfig',result.id);
    assert.equal(read.config.inferenceGatewayBaseUrl,'https://api.anthropic.com');
    assert.equal(read.config.inferenceModels[0].name,'fixture-model');
    const resolved=resolveConfig({LOCALAPPDATA:root});
    assert.equal(resolved.model,'fixture-model');
    assert.equal(resolved.apiKey,'fixture-token');
    const gateway = require('../desktop/gateway-source.cjs').resolveGateway({LOCALAPPDATA:root, USERPROFILE:root, APPDATA:root});
    assert.equal(gateway.model,'fixture-model');
    assert.equal(gateway.apiKey,'fixture-token');
    const created=await call('createConfig','Named by UI');
    assert.equal(created.entries.find(entry=>entry.id===created.id).name,'Named by UI');
  } finally {
    if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
