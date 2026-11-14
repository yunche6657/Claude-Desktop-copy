import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const assets=path.join(root,'resources','ion-dist','assets','v1');
const read=name=>fs.readFileSync(path.join(assets,name),'utf8');
const routing=read('shared-156-BLTosN8U.js');
function functionText(source,name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,name);const end=source.indexOf('function ',start+9);return source.slice(start,end).replace(/var [\s\S]*$/,'');}
test('real settings hash parser accepts models and preserves existing Claude Code route',()=>{
 const whitelist=routing.match(/var zh=(\[[\s\S]*?\]),Bh=/)[1];
 const context=vm.createContext({Cm:[],kh:()=>false,Hh:()=>[],Bh:[],xm:()=> 'general'});
 vm.runInContext(`var zh=${whitelist};${functionText(routing,'bg')}`,context);
 for(const section of ['models','general','claude-code','desktop/extensions']){
  assert.equal(vm.runInContext(`bg('/settings/${section}').section`,context),section);
 }
 assert.equal(vm.runInContext(`bg('/settings/not-a-section')`,context),null);
});
test('both actual menu callbacks open the models section in the current window',()=>{
 const source=read('cd75f6c8c-zFZzXb5w.js');
 const callbacks=[...source.matchAll(/"data-testid":"user-menu-model",icon:[\s\S]*?,onClick:(\(\)=>\{[^}]+\}),children:/g)];
 assert.equal(callbacks.length,2);
 for(const [,callback]of callbacks){const events=[];const window={location:{hash:''}};vm.runInNewContext(`(${callback})()`,{W:()=>events.push('close-menu'),r642OpenModels:id=>events.push(id),window});assert.deepEqual(events,['close-menu','models']);assert.equal(window.location.hash,'settings/models');}
 assert.match(source,/"data-testid":"user-menu-settings"[^}]*onClick:jt/);
});
test('model nav uses the original settings list and original lazy registry',()=>{
 const nav=read('shared-46-BIbZBGFq.js');
 assert.match(nav,/id:"models",href:"\/settings\/models",label:"模型",name:"模型"/);
 assert.match(nav,/models:"account"/);
 const shell=read('cc011544b-Bdta0Cl7.js');
 assert.match(shell,/models:Q\("models",\(\)=>e\(\(\)=>import\("\.\/c71860c77-BwbfSKgy.js"\),__vite__mapDeps\(\[0,1\]\)\),e=>e.ModelSettingsPage\)/);
 assert.match(shell,/"claude-code":Q\("claude-code",\(\)=>e\(\(\)=>import\("\.\/c71860c77-C3tXoNVw.js"\)/);
});
