import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createAccountStore}=require('../desktop/account-store.cjs');
const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');

test('Cowork global instructions follow the active account and persist through bridge restart',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-global-bridge-'));
 const accountStore=createAccountStore({filePath:path.join(root,'accounts.json')});
 const start=()=>{const handlers=new Map();const bridge=registerBridgeServices({ipcMain:{handle:(c,fn)=>handlers.set(c,fn),removeHandler(){}},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>null,settings:{dataDir:root},accountStore,coworkMemoryUserDataDir:root,frontend:{root:root}});return{bridge,call:(method,...args)=>handlers.get(messageChannel('claude.web','CoworkMemory',method))({},...args)}};
 let app=start();t.after(async()=>{await app.bridge.dispose();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50})});
 assert.equal(await app.call('readGlobalMemory'),null);assert.equal(await app.call('writeGlobalMemory','ignored'),false);
 const add=(account,org)=>accountStore.upsertFromTokens({accessToken:'fixture-only',account:{uuid:account},organization:{uuid:org}});
 const first=add('11111111-aaaa-bbbb-cccc-111111111111','33333333-aaaa-bbbb-cccc-333333333333');
 assert.deepEqual(accountStore.getActiveIdentity(),{accountId:'11111111-aaaa-bbbb-cccc-111111111111',orgId:'33333333-aaaa-bbbb-cccc-333333333333'});
 assert.equal(await app.call('writeGlobalMemory','first private instructions'),true);
 const folder=path.join(root,'local-agent-mode-sessions','11111111-aaaa-bbbb-cccc-111111111111','33333333-aaaa-bbbb-cccc-333333333333','memory','memory');
 fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'note.md'),'fixture memory');fs.writeFileSync(path.join(folder,'MEMORY.md'),'excluded');
 assert.equal(await app.call('writeAccountMemory','new.md','must not create'),false);
 assert.deepEqual((await app.call('listAccountMemories',true)).map(x=>x.path),['note.md']);
 assert.equal((await app.call('readAccountMemory','note.md')).content,'fixture memory');
 assert.equal(await app.call('writeAccountMemory','note.md','updated memory'),true);
 assert.equal((await app.call('readAccountMemory','note.md')).content,'updated memory');

 const second=add('22222222-aaaa-bbbb-cccc-222222222222','33333333-aaaa-bbbb-cccc-333333333333');
 accountStore.setActive(first.id);const staleWrite=app.call('writeGlobalMemory','stale write');accountStore.setActive(second.id);assert.equal(await staleWrite,false);
 assert.equal(await app.call('readGlobalMemory'),null);assert.deepEqual(await app.call('listAccountMemories',true),[]);assert.equal(await app.call('writeGlobalMemory','second private instructions'),true);
 accountStore.setActive(first.id);assert.equal(await app.call('readGlobalMemory'),'first private instructions');
 assert.equal(await app.call('deleteAccountMemory','note.md'),true);assert.equal(await app.call('readAccountMemory','note.md'),null);
 fs.writeFileSync(path.join(folder,'reset.md'),'reset fixture');
 const space=path.join(root,'local-agent-mode-sessions','11111111-aaaa-bbbb-cccc-111111111111','33333333-aaaa-bbbb-cccc-333333333333','spaces','fixture','memory');
 fs.mkdirSync(space,{recursive:true});fs.writeFileSync(path.join(space,'reset.md'),'reset fixture');
 assert.equal(await app.call('resetMemories'),true);assert.deepEqual(fs.readdirSync(folder),[]);assert.deepEqual(fs.readdirSync(space),[]);
 assert.equal(await app.call('readGlobalMemory'),'first private instructions');

 await app.bridge.dispose();app=start();assert.equal(await app.call('readGlobalMemory'),'first private instructions');
 accountStore.setActive(second.id);assert.equal(await app.call('readGlobalMemory'),'second private instructions');
 accountStore.remove(second.id);accountStore.remove(first.id);assert.equal(accountStore.getActiveIdentity(),null);assert.equal(await app.call('readGlobalMemory'),null);
});
