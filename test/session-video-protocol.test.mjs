import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createSessionVideoProtocol,MEDIA_MIME,MEDIA_DATA_URL_MAX_BYTES,PANEL_DATA_URL_MAX_BYTES,TOKEN_IDLE_TTL_MS,TOKEN_CACHE_LIMIT}=require('../desktop/session-video-protocol.cjs');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-video-'));const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);const sessions=new Map([['session-a',{cwd}]]);let clock=100;let allowed=true;const media=createSessionVideoProtocol({getSession:id=>sessions.get(id),isPathAllowed:()=>allowed,now:()=>clock});const bytes=Buffer.from([0,1,2,3,4,5,6,7,8,9,254,255]);fs.writeFileSync(path.join(cwd,'fixture.wav'),bytes);return {root,cwd,sessions,media,bytes,setClock:n=>clock=n,setAllowed:b=>allowed=b,clean(){media.dispose();fs.rmSync(root,{recursive:true,force:true});}};}

test('native media MIME mapping is explicit and unsupported files cannot mint or read',async()=>{
 const f=fixture();try{assert.equal(MEDIA_MIME['.mov'],'video/mp4');assert.equal(MEDIA_MIME['.opus'],'audio/ogg');assert.equal(MEDIA_MIME['.wav'],'audio/wav');fs.writeFileSync(path.join(f.cwd,'secret.txt'),f.bytes);assert.equal(await f.media.getSessionMediaStreamUrl('session-a','secret.txt'),null);assert.equal(await f.media.readSessionMediaAsDataUrl('session-a','secret.txt'),null);assert.equal(await f.media.getSessionMediaStreamUrl('unknown','fixture.wav'),null);
 }finally{f.clean();}
});

test('opaque v URL streams actual bytes, reuses the same capability and provides range and capped data URL fallbacks',async()=>{
 const f=fixture();try{const url=await f.media.getSessionPanelMediaStreamUrl('session-a','fixture.wav');assert.match(url,/^claude-media:\/\/v\/[A-Za-z0-9_-]{22}\?v=\d+$/);assert.equal(url.includes(encodeURIComponent(f.cwd)),false);assert.equal(await f.media.getSessionMediaStreamUrl('session-a','fixture.wav'),url);
 const full=await f.media.handle(new Request(url));assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),'audio/wav');assert.equal(full.headers.get('cache-control'),'no-store');assert.equal(full.headers.get('accept-ranges'),'bytes');assert.deepEqual(Buffer.from(await full.arrayBuffer()),f.bytes);
 const range=await f.media.handle(new Request(url,{headers:{range:'bytes=2-5'}}));assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-5/12');assert.deepEqual(Buffer.from(await range.arrayBuffer()),f.bytes.subarray(2,6));
 const suffix=await f.media.handle(new Request(url,{headers:{range:'bytes=-2'}}));assert.equal(suffix.status,206);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),f.bytes.subarray(-2));
 const bad=await f.media.handle(new Request(url,{headers:{range:'bytes=100-'}}));assert.equal(bad.status,416);assert.equal(bad.headers.get('content-range'),'bytes */12');
 const multi=await f.media.handle(new Request(url,{headers:{range:'bytes=1-2,5-6'}}));assert.equal(multi.status,200);await multi.body.cancel();
 assert.equal(await f.media.readSessionMediaAsDataUrl('session-a','fixture.wav'),'data:audio/wav;base64,'+f.bytes.toString('base64'));assert.equal(await f.media.readSessionPanelMediaAsDataUrl('session-a','fixture.wav'),'data:audio/wav;base64,'+f.bytes.toString('base64'));
 }finally{f.clean();}
});

test('native data URL limits differ from unbounded media streaming',async()=>{
 const f=fixture();try{assert.equal(MEDIA_DATA_URL_MAX_BYTES,52428800);assert.equal(PANEL_DATA_URL_MAX_BYTES,26214400);const large=path.join(f.cwd,'large.mp4');const fd=fs.openSync(large,'w');fs.ftruncateSync(fd,MEDIA_DATA_URL_MAX_BYTES+1);fs.closeSync(fd);assert.equal(await f.media.readSessionMediaAsDataUrl('session-a',large),null);assert.equal(await f.media.readSessionPanelMediaAsDataUrl('session-a',large),null);const url=await f.media.getSessionMediaStreamUrl('session-a',large);assert.ok(url);const range=await f.media.handle(new Request(url,{headers:{range:'bytes=0-7'}}));assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,8);
 fs.truncateSync(large,PANEL_DATA_URL_MAX_BYTES+1);assert.equal(await f.media.readSessionPanelMediaAsDataUrl('session-a',large),null);
 }finally{f.clean();}
});

test('cache expires after six idle hours but successful accesses extend its idle lifetime',async()=>{
 const f=fixture();try{assert.equal(TOKEN_IDLE_TTL_MS,21600000);const url=await f.media.getSessionMediaStreamUrl('session-a','fixture.wav');f.setClock(100+TOKEN_IDLE_TTL_MS);const alive=await f.media.handle(new Request(url));assert.equal(alive.status,200);await alive.arrayBuffer();f.setClock(100+TOKEN_IDLE_TTL_MS*2);const extended=await f.media.handle(new Request(url));assert.equal(extended.status,200);await extended.arrayBuffer();f.setClock(101+TOKEN_IDLE_TTL_MS*3);assert.equal((await f.media.handle(new Request(url))).status,404);const renewed=await f.media.getSessionMediaStreamUrl('session-a','fixture.wav');assert.notEqual(renewed,url);
 }finally{f.clean();}
});

test('64-entry LRU evicts the oldest capability and cache hits update recency',async()=>{
 const f=fixture();try{assert.equal(TOKEN_CACHE_LIMIT,64);const urls=[];for(let i=0;i<64;i++){const name='clip-'+i+'.mp3';fs.writeFileSync(path.join(f.cwd,name),f.bytes);urls.push(await f.media.getSessionMediaStreamUrl('session-a',name));}assert.ok(urls[0]);const touched=await f.media.handle(new Request(urls[0]));await touched.arrayBuffer();fs.writeFileSync(path.join(f.cwd,'new.mp3'),f.bytes);assert.ok(await f.media.getSessionMediaStreamUrl('session-a','new.mp3'));assert.equal((await f.media.handle(new Request(urls[1]))).status,404);const stillAlive=await f.media.handle(new Request(urls[0]));assert.equal(stillAlive.status,200);await stillAlive.arrayBuffer();
 }finally{f.clean();}
});

test('tokens recheck current session grants and policy rather than opening arbitrary absolute paths',async()=>{
 const f=fixture();try{fs.writeFileSync(path.join(f.root,'private.wav'),f.bytes);assert.equal(await f.media.getSessionMediaStreamUrl('session-a','../private.wav'),null);const url=await f.media.getSessionMediaStreamUrl('session-a','fixture.wav');f.setAllowed(false);assert.equal((await f.media.handle(new Request(url))).status,404);assert.equal(await f.media.getSessionMediaStreamUrl('session-a','fixture.wav'),null);f.setAllowed(true);f.sessions.delete('session-a');assert.equal((await f.media.handle(new Request(url))).status,404);
 }finally{f.clean();}
});

test('a minted token rejects later external symlink substitution and additional roots remain explicit session grants',async()=>{
 const f=fixture();try{const sub=path.join(f.cwd,'sub');fs.mkdirSync(sub);fs.writeFileSync(path.join(sub,'clip.wav'),f.bytes);const url=await f.media.getSessionMediaStreamUrl('session-a',path.join(sub,'clip.wav'));const external=path.join(f.root,'external');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'clip.wav'),f.bytes);fs.rmSync(sub,{recursive:true});fs.symlinkSync(external,sub,process.platform==='win32'?'junction':'dir');assert.equal((await f.media.handle(new Request(url))).status,404);assert.equal(await f.media.getSessionMediaStreamUrl('session-a',path.join(external,'clip.wav')),null);
 f.sessions.set('session-a',{cwd:f.cwd,additionalDirectories:[external]});const granted=await f.media.getSessionPanelMediaStreamUrl('session-a',path.join(external,'clip.wav'));assert.ok(granted);const response=await f.media.handle(new Request(granted));assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
 }finally{f.clean();}
});

test('revoke and clear invalidate old capabilities while later permitted remints receive fresh tokens',async()=>{
 const f=fixture();try{const url=await f.media.getSessionMediaStreamUrl('session-a','fixture.wav');f.media.revokeSession('session-a');assert.equal((await f.media.handle(new Request(url))).status,404);const renewed=await f.media.getSessionMediaStreamUrl('session-a','fixture.wav');assert.notEqual(renewed,url);f.media.clear();assert.equal((await f.media.handle(new Request(renewed))).status,404);assert.ok(await f.media.getSessionMediaStreamUrl('session-a','fixture.wav'));f.media.dispose();assert.equal(await f.media.getSessionMediaStreamUrl('session-a','fixture.wav'),null);assert.equal((await f.media.handle(new Request(url))).status,404);
 }finally{f.clean();}
});


test('a shared canonical capability retains only currently authorized session owners',async()=>{
 const f=fixture();try{const first=await f.media.getSessionMediaStreamUrl('session-a','fixture.wav');f.sessions.set('session-b',{cwd:f.cwd});const second=await f.media.getSessionMediaStreamUrl('session-b','fixture.wav');assert.equal(first,second);f.media.revokeSession('session-a');const otherOwner=await f.media.handle(new Request(second));assert.equal(otherOwner.status,200);await otherOwner.arrayBuffer();f.sessions.delete('session-b');assert.equal((await f.media.handle(new Request(second))).status,404);
 }finally{f.clean();}
});


test('panel admits explicit native granted roots but ignores userSelectedFolders-only and resolves literals before harness fallback',async()=>{
 const f=fixture();try{const origin=path.join(f.root,'origin'),harness=path.join(f.root,'harness'),selected=path.join(f.root,'selected');fs.mkdirSync(origin);fs.mkdirSync(harness);fs.mkdirSync(selected);fs.writeFileSync(path.join(origin,'origin.wav'),f.bytes);fs.writeFileSync(path.join(harness,'fixture.wav'),Buffer.from('harness bytes'));fs.writeFileSync(path.join(harness,'only-harness.wav'),f.bytes);fs.writeFileSync(path.join(selected,'ungranted.wav'),f.bytes);
 f.sessions.set('session-a',{cwd:f.cwd,originCwd:origin,harnessCwd:harness,userSelectedFolders:[selected]});
 const originUrl=await f.media.getSessionPanelMediaStreamUrl('session-a',path.join(origin,'origin.wav'));assert.ok(originUrl);const originResponse=await f.media.handle(new Request(originUrl));assert.deepEqual(Buffer.from(await originResponse.arrayBuffer()),f.bytes);
 assert.equal(await f.media.getSessionPanelMediaStreamUrl('session-a',path.join(selected,'ungranted.wav')),null);assert.equal(await f.media.readSessionPanelMediaAsDataUrl('session-a',path.join(selected,'ungranted.wav')),null);assert.equal(await f.media.getSessionMediaStreamUrl('session-a',path.join(selected,'ungranted.wav')),null);
 assert.equal(await f.media.readSessionPanelMediaAsDataUrl('session-a','fixture.wav'),'data:audio/wav;base64,'+f.bytes.toString('base64'));
 assert.equal(await f.media.readSessionMediaAsDataUrl('session-a','fixture.wav'),'data:audio/wav;base64,'+Buffer.from('harness bytes').toString('base64'));
 assert.equal(await f.media.getSessionPanelMediaStreamUrl('session-a','only-harness.wav'),null);assert.ok(await f.media.getSessionMediaStreamUrl('session-a','only-harness.wav'));
 }finally{f.clean();}
});
