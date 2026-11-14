import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('Launch preload matches native message-event channels and preserves all callback arguments', () => {
  const text=fs.readFileSync(new URL('../desktop/preload-frontend.cjs',import.meta.url),'utf8');
  const source=text.slice(text.indexOf('const NAMESPACE ='),text.indexOf('function expose('));
  const ipcRenderer=new EventEmitter();
  const buildService=vm.runInNewContext(source+';buildService',{ipcRenderer,require:()=>require('../desktop/shim/bridge-map.json')});
  const api=buildService('claude.web','Launch',['onPreviewUrlChanged','onPreviewTabsChanged']);
  const urls=[],tabs=[];
  const offUrl=api.onPreviewUrlChanged((...args)=>urls.push(args));
  const offTabs=api.onPreviewTabsChanged((...args)=>tabs.push(args));
  const prefix='$eipc_message$_6010a08f-a0fa-48b4-99da-0689b9e2de7b_$_claude.web_$_Launch_$_';
  ipcRenderer.emit(prefix+'previewUrlChanged',{},'server','http://localhost:1234');
  ipcRenderer.emit(prefix+'previewTabsChanged',{},'server',[{tabId:'tab'}],'tab','session');
  assert.deepEqual(urls,[['server','http://localhost:1234']]);
  assert.deepEqual(tabs,[['server',[{tabId:'tab'}],'tab','session']]);
  offUrl();offTabs();
  assert.equal(ipcRenderer.listenerCount(prefix+'previewUrlChanged'),0);
  assert.equal(ipcRenderer.listenerCount(prefix+'previewTabsChanged'),0);
});
