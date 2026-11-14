import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createLandingDirectory}=require('../desktop/landing-directory.cjs');
function fixture(t) {
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'landing-dir-')),root=path.join(base,'root'),outside=path.join(base,'outside');
 fs.mkdirSync(root);fs.mkdirSync(outside);fs.mkdirSync(path.join(root,'sub'));fs.writeFileSync(path.join(root,'你好.txt'),'actual');fs.writeFileSync(path.join(root,'sub','nested'),'x');
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 return {root,outside,service:createLandingDirectory({isTrusted:()=>true})};
}
test('landing tree enumerates actual entries and native metadata exclusions without a session',async t=>{
 const f=fixture(t);for(const name of ['.git','.DS_Store','desktop.ini'])fs.writeFileSync(path.join(f.root,name),'');
 assert.deepEqual((await f.service.listDirectoryAtCwd(f.root,f.root)).map(x=>x.name).sort(),['sub','你好.txt']);
 const nested=await f.service.listDirectoryAtCwd(f.root,'sub');assert.deepEqual(nested,[{name:'nested',path:path.join(f.root,'sub','nested'),isDirectory:false}]);
});
test('untrusted landing roots reject while lexically or canonically outside paths enumerate nothing',async t=>{
 const f=fixture(t);await assert.rejects(createLandingDirectory().listDirectoryAtCwd(f.root,f.root),/could not be read/);
 assert.deepEqual(await f.service.listDirectoryAtCwd(f.root,f.outside),[]);
 fs.symlinkSync(f.outside,path.join(f.root,'escape'),'junction');assert.deepEqual(await f.service.listDirectoryAtCwd(f.root,path.join(f.root,'escape')),[]);
});
test('links are classified as actual internal directories, external paths and cycles',async t=>{
 const f=fixture(t);fs.symlinkSync(path.join(f.root,'sub'),path.join(f.root,'internal'),'junction');fs.symlinkSync(f.outside,path.join(f.root,'external'),'junction');fs.symlinkSync(f.root,path.join(f.root,'cycle'),'junction');
 const rows=await f.service.listDirectoryAtCwd(f.root,f.root);
 assert.equal(rows.find(x=>x.name==='internal').link.state,'ok');assert.equal(rows.find(x=>x.name==='internal').isDirectory,true);
 assert.equal(rows.find(x=>x.name==='external').link.state,'external');assert.equal(rows.find(x=>x.name==='cycle').link.state,'cycle');
});
test('missing roots fail visibly and invalid request shapes return empty',async t=>{
 const f=fixture(t);await assert.rejects(f.service.listDirectoryAtCwd(path.join(f.root,'gone'),'.'),/could not be read/);
 assert.deepEqual(await f.service.listDirectoryAtCwd(f.root,null),[]);
 await assert.rejects(f.service.listDirectoryAtCwd(f.root,'gone'),/could not be read/);
});

test('landing IPC shares the saved project trust store without creating a session', async t => {
 const f=fixture(t), prior=process.env.CLAUDE_TRUST_STORE;
 process.env.CLAUDE_TRUST_STORE=path.join(f.outside,'trust.json');
 const handlers=new Map();
 const {registerBridgeServices,messageChannel}=require('../desktop/bridge-services.cjs');
 const bridge=registerBridgeServices({ipcMain:{handle:(c,fn)=>handlers.set(c,fn),removeHandler:c=>handlers.delete(c)},bridgeMap:require('../desktop/shim/bridge-map.json'),getMainWindow:()=>null,settings:{},frontend:{root:f.root}});
 t.after(async()=>{await bridge.dispose();if(prior===undefined)delete process.env.CLAUDE_TRUST_STORE;else process.env.CLAUDE_TRUST_STORE=prior;});
 const call=(method,...args)=>handlers.get(messageChannel('claude.web','LocalSessions',method))({},...args);
 await call('saveTrust',f.root,false);
 await assert.rejects(call('listDirectoryAtCwd',f.root,f.root),/could not be read/);
 assert.equal((await call('saveTrust',f.root,true)).ok,true);
 assert.ok((await call('listDirectoryAtCwd',f.root,f.root)).some(row=>row.name==='你好.txt'));
});

test('native trust resolves canonical ancestors and retains explicitly trusted lexical alias roots',async t=>{
 const f=fixture(t),alias=path.join(path.dirname(f.root),'alias');fs.symlinkSync(f.root,alias,'junction');
 const canonical=createLandingDirectory({isTrusted:root=>path.relative(f.root,root)===''});
 assert.ok((await canonical.listDirectoryAtCwd(alias,alias)).some(row=>row.name==='sub'));
 const lexical=createLandingDirectory({isTrusted:root=>root===alias,getTrustedRoot:root=>root===alias?alias:null});
 assert.ok((await lexical.listDirectoryAtCwd(alias,alias)).some(row=>row.name==='sub'));
 const nested=createLandingDirectory({isTrusted:()=>false,getTrustedRoot:()=>f.root});
 assert.equal((await nested.listDirectoryAtCwd(path.join(f.root,'sub'),'.'))[0].name,'nested');
});
test('trust-source exceptions become the native directory refusal without exposing callback details',async t=>{
 const f=fixture(t),service=createLandingDirectory({isTrusted:()=>{throw Error('private trust-store path');}});
 await assert.rejects(service.listDirectoryAtCwd(f.root,f.root),error=>error.message==='Directory could not be read');
});
test('link classification limits filesystem fan-out to eight link workers',async t=>{
 const f=fixture(t);for(let i=0;i<24;i++)fs.symlinkSync(path.join(f.root,'sub'),path.join(f.root,'j'+i),'junction');
 const original=fs.promises.readlink;let active=0,peak=0;
 fs.promises.readlink=async(...args)=>{active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,2));return await original(...args);}finally{active--;}};
 try{const rows=await f.service.listDirectoryAtCwd(f.root,f.root);assert.equal(rows.filter(row=>row.link?.state==='ok').length,24);assert.ok(peak>1&&peak<=8);}
 finally{fs.promises.readlink=original;}
});
test('native lstat recheck handles readdir links whose runtime exposes directory metadata instead',async t=>{
 const f=fixture(t);const link=path.join(f.root,'j');fs.symlinkSync(path.join(f.root,'sub'),link,'junction');
 const original=fs.promises.lstat;
 fs.promises.lstat=async(...args)=>{const result=await original(...args);if(args[0]===link)return {isSymbolicLink:()=>false,isDirectory:()=>true};return result;};
 try{const row=(await f.service.listDirectoryAtCwd(f.root,f.root)).find(row=>row.name==='j');assert.equal(row.isDirectory,true);assert.equal(row.link,undefined);}
 finally{fs.promises.lstat=original;}
});
