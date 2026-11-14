import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { publicPreferences } = require('../desktop/preference-projection.cjs');

test('preference projection matches the fixed desktop native function', () => {
  const source = fs.readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
  const start = source.indexOf('QRt=e=>'), end = source.indexOf(',$Rt=', start);
  assert.ok(start >= 0 && end > start);
  const native = vm.runInNewContext(`(${source.slice(start + 4, end)})`);
  const value = {theme:'dark', remoteSessionFolderGrants:{secret:'path'}, ccSshHostToolGrants:['private'],
    launchPreviewPrivateNetworkReadPins:{private:'host'}, hushedHeronKey:{accelerator:'Ctrl+K',secret:'hidden'}};
  assert.deepEqual(publicPreferences(value), JSON.parse(JSON.stringify(native(value))));
});

test('preload preference subscription uses the native message channel and detaches', () => {
  const source = fs.readFileSync(new URL('../desktop/preload-frontend.cjs', import.meta.url), 'utf8');
  const start = source.indexOf('const NAMESPACE ='), end = source.indexOf('\nfunction expose(', start);
  const listeners = new Map();
  const ipcRenderer = {on:(channel, fn)=>listeners.set(channel, fn), removeListener:(channel, fn)=>{if(listeners.get(channel)===fn)listeners.delete(channel);}};
  const build = vm.runInNewContext(source.slice(start,end) + '; buildService', {ipcRenderer, require:()=>({})});
  const api = build('claude.settings','AppPreferences',['onPreferencesChanged']);
  const received=[]; const detach=api.onPreferencesChanged(value=>received.push(value));
  const [channel, fn] = [...listeners][0];
  assert.match(channel, /^\$eipc_message\$_.*_\$_claude\.settings_\$_AppPreferences_\$_preferencesChanged$/);
  fn({}, {theme:'dark'}); assert.equal(received[0].theme, 'dark'); detach(); assert.equal(listeners.size,0);
});

test('persisted preference changes notify with the same redacted snapshot as getPreferences', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'preference-event-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const handlers = new Map(), sent=[];
  const settings={dataDir:dir,sidebarMode:'epitaxy',themeMode:'system',preferences:{remoteSessionFolderGrants:{secret:'hidden'}}};
  require('../desktop/bridge-services.cjs').registerBridgeServices({
    ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn),removeHandler:ch=>handlers.delete(ch)},
    bridgeMap:require('../desktop/shim/bridge-map.json'),
    getMainWindow:()=>({isDestroyed:()=>false,webContents:{send:(channel,payload)=>sent.push({channel,payload})}}),
    settings,frontend:{root:dir},
  });
  const call=(method,...args)=>{const entry=[...handlers].find(([c])=>c.endsWith(`_$_AppPreferences_$_${method}`));assert.ok(entry);return entry[1]({},...args);};
  await call('setPreference','theme','dark');
  const event=sent.find(x=>x.channel.endsWith('_$_AppPreferences_$_preferencesChanged'));
  assert.ok(event); assert.deepEqual(event.payload,await call('getPreferences'));
  assert.deepEqual(event.payload.remoteSessionFolderGrants,{}); assert.equal(event.payload.theme,'dark');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'preferences.json'),'utf8')).theme,'dark');
});

test('failed preference persistence keeps the in-memory value and emits the projected update', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'preference-failure-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'preferences.json'));
  fs.writeFileSync(path.join(dir,'preferences.json.other.tmp'),'other writer');
  const handlers = new Map(), sent=[];
  const settings={dataDir:dir,sidebarMode:'epitaxy',themeMode:'system',preferences:{theme:'light'}};
  require('../desktop/bridge-services.cjs').registerBridgeServices({
    ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn),removeHandler:ch=>handlers.delete(ch)},
    bridgeMap:require('../desktop/shim/bridge-map.json'),
    getMainWindow:()=>({isDestroyed:()=>false,webContents:{send:(channel,payload)=>sent.push({channel,payload})}}),
    settings,frontend:{root:dir},
  });
  const call=(method,...args)=>{const entry=[...handlers].find(([c])=>c.endsWith(`_$_AppPreferences_$_${method}`));assert.ok(entry);return entry[1]({},...args);};
  await call('setPreference','theme','dark');
  assert.equal((await call('getPreferences')).theme,'dark');
  assert.deepEqual(fs.readdirSync(dir).filter(name=>name.startsWith('preferences.json')).sort(),['preferences.json','preferences.json.other.tmp']);
  const events=sent.filter(x=>x.channel.endsWith('_$_AppPreferences_$_preferencesChanged'));
  assert.equal(events.length,1); assert.equal(events[0].payload.theme,'dark');
});
