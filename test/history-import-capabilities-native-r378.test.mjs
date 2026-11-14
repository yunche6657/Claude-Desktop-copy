import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');

test('unavailable import exposes native capability and empty scan shapes',async()=>{
 const handlers=new Map();const bridge=registerBridgeServices({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler(){}},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>null,settings:{},frontend:{root:process.cwd()}});
 try{const call=(method,...args)=>handlers.get(messageChannel('claude.settings','HistoryImport',method))({},...args);
  const caps=await call('getImportCapabilities');for(const key of ['remotePull','remotePullConfigured','localZip','localSessions','sessionExport','hostLoopRequired','cliUpdateRequired','hasImportableSessions'])assert.equal(caps[key],false,key);
  assert.equal(caps.local1PSessionCount,0);assert.equal(caps.promptBanner,'off');
  const scan=await call('scanSessionSource','fixture');assert.equal(scan.sourceId,'fixture');assert.equal(scan.shape,'unknown');assert.deepEqual(scan.sessions,[]);
  const result=await call('importSessionSources',0,[]);assert.equal(result.imported,0);assert.equal(result.skipped,0);
 }finally{await bridge.dispose()}
});
