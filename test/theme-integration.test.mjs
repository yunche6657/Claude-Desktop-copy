import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {themePrompt,themeRequestContext}=require('../desktop/theme-prompt.cjs');
test('appearance requests retain their exact file context on system-stripping gateways',()=>{
  const context='<xiaoke-desktop-themes> C:\\fixture\\theme.json </xiaoke-desktop-themes>';
  assert.equal(themeRequestContext('把小克主题改成深色极光',context),context);
  assert.equal(themeRequestContext('fix the login bug',context),'');
  assert.equal(themeRequestContext('/theme',context),'');
});
test('theme prompt provides a dedicated file and finite schema without changing unrelated requests',()=>{
 const controller={getThemeFile:()=> 'C:\\fixture\\themes\\theme.json',listScenes:()=>[{id:'aurora',title:'Aurora',mode:'dark',svg:'secret-svg-not-in-prompt'}]};
 const prompt=themePrompt(controller);assert.ok(prompt.includes(JSON.stringify(controller.getThemeFile())));assert.ok(prompt.includes('aurora'));assert.ok(prompt.includes('Only when the user asks'));assert.ok(prompt.includes('Do not modify the theme for unrelated'));assert.equal(prompt.includes('secret-svg-not-in-prompt'),false);
});
test('CCB backend forwards appended theme arguments alongside streaming flag',()=>{
 const main=fs.readFileSync(new URL('../desktop/main.cjs',import.meta.url),'utf8');
 assert.match(main,/function createCcbBackend\(\{ cwd, log, acquireSlot, extraArgs = \[\] \}\)/);
 assert.ok(main.includes("extraArgs: ['--include-partial-messages'].concat(extraArgs)"));
 assert.ok(main.includes("extraArgs: ['--append-system-prompt', require('./theme-prompt.cjs').themePrompt(themeController), '--add-dir', path.dirname(themeController.getThemeFile())]"));
});
test('theme IPC is exposed and wired to controller methods',async()=>{
 const bridgeMap=require('../desktop/shim/bridge-map.json');assert.deepEqual(bridgeMap['claude.web'].CustomThemes,['getState','listScenes','setTheme','reset','getThemeFile','setWindowMode']);
 const handlers=new Map();const calls=[];const state={name:'fixture'};const controller={getState:()=>state,listScenes:()=>[],setTheme:value=>{calls.push(value);return value},reset:()=>state,getThemeFile:()=>'/fixture/theme.json'};
 require('../desktop/bridge-services.cjs').registerBridgeServices({ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn),removeHandler:channel=>handlers.delete(channel)},bridgeMap,getMainWindow:()=>null,settings:{},frontend:{root:process.cwd()},themeController:controller});
 const find=name=>[...handlers].find(([channel])=>channel.endsWith(`_$_CustomThemes_$_${name}`))[1];assert.deepEqual(await find('getState')({}),state);assert.equal(await find('getThemeFile')({}),'/fixture/theme.json');await find('setTheme')({},{motion:false});assert.deepEqual(calls,[{motion:false}]);
});
