import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {GitHubUpdateService,releaseState,RELEASES_URL}=require('../desktop/github-update-service.cjs');
const {createUpdateDialog}=require('../desktop/update-dialog.cjs');
const release=(version='0.3.0')=>({tag_name:`v${version}`,body:'Release notes',assets:[{name:`Xiaoke-${version}-x64.exe`,state:'uploaded',browser_download_url:`${RELEASES_URL}/download/v${version}/Xiaoke-${version}-x64.exe`}]});
test('stable GitHub release requires exact repository installer and compares versions',()=>{
 assert.equal(releaseState(release(),'0.2.9','win32','x64').status,'available');
 assert.equal(releaseState(release(),'0.3.0','win32','x64').status,'current');
 assert.equal(releaseState(release(),'0.4.0','win32','x64').status,'current');
 for(const invalid of [{...release(),draft:true},{...release(),prerelease:true},{...release(),assets:[]},{...release(),assets:[{...release().assets[0],browser_download_url:'https://example.com/setup.exe'}]}])assert.throws(()=>releaseState(invalid,'0.2.9','win32','x64'));
});
test('check coalesces requests and errors offer the fixed release page',async()=>{
 let calls=0;const service=new GitHubUpdateService({currentVersion:'0.2.9',platform:'win32',arch:'x64',fetchRelease:async()=>{calls++;return release()}});
 const states=await Promise.all([service.check(),service.check()]);assert.equal(calls,1);assert.equal(states[0].status,'available');
 service.fetchRelease=async()=>{throw Error('private transport detail')};const state=await service.check();assert.equal(state.status,'error');assert.equal(state.releaseUrl,RELEASES_URL);assert.equal(state.message.includes('private'),false);
});
test('dialog opens selected installer or notes, cancellation makes no request',async()=>{
 for(const response of [0,1,2]){
 const state=releaseState(release(),'0.2.9','win32','x64');const opened=[];
 const show=createUpdateDialog({service:{getState:()=>state,check:async()=>state},dialog:{showMessageBox:async()=>({response})},shell:{openExternal:async url=>opened.push(url)},getWindow:()=>null});
 await show();assert.deepEqual(opened,response===2?[]:[response===0?state.downloadUrl:state.releaseUrl]);
 }
});
