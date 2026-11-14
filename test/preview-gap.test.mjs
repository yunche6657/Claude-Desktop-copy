// Dev-server supervision is implemented; embedded browser tabs remain a separate gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registerBridgeServices, messageChannel } = require('../desktop/bridge-services.cjs');
const { createStoreBridge } = require('../desktop/service-store.cjs');

test('real Launch IPC drives process state, HTTP readiness, logs and stop without inventing browser tabs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-ipc-'));
  const oldTrust = process.env.CLAUDE_TRUST_STORE;
  const oldConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_TRUST_STORE = path.join(root, 'trust.json');
  process.env.CLAUDE_CONFIG_DIR = root;
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'launch.json'), JSON.stringify({ configurations: [{ name: 'fixture',
    runtimeExecutable: process.execPath, runtimeArgs: ['fixture.cjs'] }] }));
  fs.writeFileSync(path.join(root, 'fixture.cjs'), "require('node:http').createServer((q,r)=>r.end('LAUNCH_IPC_OK')).listen(0,'127.0.0.1',function(){console.log('http://127.0.0.1:'+this.address().port)})");
  const handlers = new Map(), ipcMain = new EventEmitter(), renderer = new EventEmitter();
  ipcMain.handle = (key, fn) => handlers.set(key, fn);
  ipcMain.removeHandler = key => handlers.delete(key);
  renderer.invoke = async key => handlers.get(key)({});
  renderer.sendSync = key => { const e = {}; ipcMain.emit(key, e); return e.returnValue; };
  const bridge = registerBridgeServices({ ipcMain, bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({isDestroyed: () => false, webContents: {send: (channel, value) => renderer.emit(channel, {}, value)}}),
    settings: {}, frontend: {root} });
  t.after(async () => {
    await bridge.dispose();
    if(oldTrust === undefined) delete process.env.CLAUDE_TRUST_STORE; else process.env.CLAUDE_TRUST_STORE=oldTrust;
    if(oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR=oldConfig;
    fs.rmSync(root, {recursive:true,force:true});
  });
  const call = (service, method, ...args) => handlers.get(messageChannel('claude.web', service, method))({}, ...args);
  const store = createStoreBridge(renderer, 'claude.web', 'Launch', 'activeServers');
  assert.deepEqual(await store.getState(), []);
  assert.deepEqual(await call('Launch','getAllSessionPreviewTabs'), []);
  const refused = await call('Launch','startFromConfig',root,'fixture','sid');
  assert.equal(refused.refused,true);
  assert.deepEqual(store.getStateSync(), []);
  assert.equal((await call('LocalSessions','saveTrust',root,true)).ok,true);
  const updates=[];const detach=store.onStateChange(state=>updates.push(state));t.after(detach);
  const started=await call('Launch','startFromConfig',root,'fixture','sid');
  assert.equal(typeof started.serverId,'string');
  assert.equal(started.previewId,undefined);
  assert.equal(started.tabId,undefined);
  const url=await call('Launch','getPreviewUrl',started.serverId);
  assert.equal(await (await fetch(url)).text(),'LAUNCH_IPC_OK');
  assert.equal((await store.getState())[0].status,'running');
  assert.ok(updates.some(rows=>rows.some(row=>row.status==='starting')));
  assert.ok(updates.some(rows=>rows.some(row=>row.status==='running')));
  assert.ok((await call('Launch','getLogs',started.serverId)).some(row=>row.line.includes(new URL(url).origin)));
  await call('Launch','stopServer',started.serverId);
  assert.equal(store.getStateSync()[0].status,'stopped');
  assert.equal(await call('Launch','getPreviewUrl',started.serverId),null);
  await assert.rejects(fetch(url));
  assert.deepEqual(await call('Launch','getAllSessionPreviewTabs'),[]);
});
