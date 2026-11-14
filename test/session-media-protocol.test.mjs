import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createSessionMediaProtocol,STREAM_IMAGE_MIN_BYTES:MIN,MAX_IMAGE_BYTES:MAX,SESSION_MEDIA_SCHEME}=require('../desktop/session-media-protocol.cjs');
const {createSessionImages}=require('../desktop/session-images.cjs');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-media-'));const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);const sessions=new Map([['local_fixture',{cwd}]]);const media=createSessionMediaProtocol({getSession:id=>sessions.get(id)});const image=Buffer.alloc(MIN);for(let i=0;i<image.length;i++)image[i]=i%251;const file=path.join(cwd,'图 片.png');fs.writeFileSync(file,image);return{root,cwd,sessions,media,image,file,clean(){media.dispose();fs.rmSync(root,{recursive:true,force:true})}};}

test('stream URL names a signed session-relative path and serves actual file bytes',async()=>{
 const f=fixture();try{const images=createSessionImages({getSession:id=>f.sessions.get(id),mediaProtocol:f.media});const url=await images.getSessionImageStreamUrl('local_fixture',f.file);assert.ok(url.startsWith('claude-media://s/local_fixture/'));assert.equal(new URL(url).pathname.split('/').at(-1),encodeURIComponent('图 片.png'));assert.ok(new URL(url).searchParams.has('sig'));assert.ok(new URL(url).searchParams.has('v'));assert.equal(url.includes(encodeURIComponent(f.cwd)),false);
 const response=await f.media.handle(new Request(url));assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('accept-ranges'),'bytes');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('content-length'),String(MIN));assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.image);
 }finally{f.clean();}
});

test('mint obeys native 1MiB minimum, 10MiB maximum, primary root and raster MIME restrictions',async()=>{
 const f=fixture();try{fs.writeFileSync(path.join(f.cwd,'small.png'),Buffer.alloc(MIN-1));assert.equal(await f.media.mintImageUrl('local_fixture','small.png'),null);
 const fd=fs.openSync(path.join(f.cwd,'limit.avif'),'w');fs.ftruncateSync(fd,MAX);fs.closeSync(fd);assert.ok(await f.media.mintImageUrl('local_fixture','limit.avif'));fs.truncateSync(path.join(f.cwd,'limit.avif'),MAX+1);assert.equal(await f.media.mintImageUrl('local_fixture','limit.avif'),null);
 fs.writeFileSync(path.join(f.cwd,'vector.svg'),Buffer.alloc(MIN));assert.equal(await f.media.mintImageUrl('local_fixture','vector.svg'),null);
 const extra=path.join(f.root,'extra');fs.mkdirSync(extra);fs.writeFileSync(path.join(extra,'selected.png'),f.image);f.sessions.set('local_fixture',{cwd:f.cwd,additionalDirectories:[extra]});assert.equal(await f.media.mintImageUrl('local_fixture',path.join(extra,'selected.png')),null);assert.equal(await f.media.mintImageUrl('missing',f.file),null);
 }finally{f.clean();}
});

test('native single ranges, suffixes, malformed ranges and unsatisfiable ranges return correct status and bytes',async()=>{
 const f=fixture();try{const url=await f.media.mintImageUrl('local_fixture',f.file);
 const middle=await f.media.handle(new Request(url,{headers:{range:'bytes=7-11'}}));assert.equal(middle.status,206);assert.equal(middle.headers.get('content-range'),'bytes 7-11/'+MIN);assert.deepEqual(Buffer.from(await middle.arrayBuffer()),f.image.subarray(7,12));
 const suffix=await f.media.handle(new Request(url,{headers:{range:'bytes=-4'}}));assert.equal(suffix.status,206);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),f.image.subarray(-4));
 const open=await f.media.handle(new Request(url,{headers:{range:'bytes='+String(MIN-3)+'-'}}));assert.equal(open.status,206);assert.deepEqual(Buffer.from(await open.arrayBuffer()),f.image.subarray(-3));
 const malformed=await f.media.handle(new Request(url,{headers:{range:'bytes=1-2,3-4'}}));assert.equal(malformed.status,200);assert.equal((await malformed.arrayBuffer()).byteLength,MIN);
 const reversed=await f.media.handle(new Request(url,{headers:{range:'bytes=8-2'}}));assert.equal(reversed.status,200);await reversed.body.cancel();
 const unsatisfiable=await f.media.handle(new Request(url,{headers:{range:'bytes='+MIN+'-'}}));assert.equal(unsatisfiable.status,416);assert.equal(unsatisfiable.headers.get('content-range'),'bytes */'+MIN);
 const zeroSuffix=await f.media.handle(new Request(url,{headers:{range:'bytes=-0'}}));assert.equal(zeroSuffix.status,416);
 const head=await f.media.handle(new Request(url,{method:'HEAD',headers:{range:'bytes=2-4'}}));assert.equal(head.status,206);assert.equal(head.headers.get('content-length'),'3');assert.equal(head.body,null);
 }finally{f.clean();}
});

test('signatures cannot authorize another session, sibling file, new root or outside junction',async()=>{
 const f=fixture();try{const url=await f.media.mintImageUrl('local_fixture',f.file);fs.writeFileSync(path.join(f.cwd,'other.png'),f.image);f.sessions.set('other_session',{cwd:f.cwd});
 const otherSession=url.replace('/local_fixture/','/other_session/');assert.equal((await f.media.handle(new Request(otherSession))).status,404);
 const otherFile=new URL(url);otherFile.pathname='/local_fixture/other.png';assert.equal((await f.media.handle(new Request(otherFile))).status,404);
 const noSig=new URL(url);noSig.searchParams.delete('sig');assert.equal((await f.media.handle(new Request(noSig))).status,404);
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'private.png'),f.image);fs.symlinkSync(outside,path.join(f.cwd,'external'),process.platform==='win32'?'junction':'dir');assert.equal(await f.media.mintImageUrl('local_fixture','external/private.png'),null);
 f.sessions.set('local_fixture',{cwd:outside});assert.equal((await f.media.handle(new Request(url))).status,404);f.sessions.delete('local_fixture');assert.equal((await f.media.handle(new Request(url))).status,404);
 }finally{f.clean();}
});

test('serving revalidates file size and handles empty replacement without buffering a data URL',async()=>{
 const f=fixture();try{const url=await f.media.mintImageUrl('local_fixture',f.file);fs.truncateSync(f.file,MAX+1);assert.equal((await f.media.handle(new Request(url))).status,404);fs.truncateSync(f.file,0);const empty=await f.media.handle(new Request(url));assert.equal(empty.status,200);assert.equal(empty.headers.get('content-length'),'0');assert.equal((await empty.arrayBuffer()).byteLength,0);
 }finally{f.clean();}
});

test('revoking a session and disposing the protocol revoke old URLs and remove the handler',async()=>{
 const f=fixture();try{const url=await f.media.mintImageUrl('local_fixture',f.file);const registrations=[];const protocol={handle:(...args)=>registrations.push(args),unhandle:name=>registrations.push(['remove',name])};f.media.install(protocol);assert.equal(registrations[0][0],'claude-media');assert.equal(SESSION_MEDIA_SCHEME.privileges.stream,true);assert.equal(SESSION_MEDIA_SCHEME.privileges.secure,true);
 f.media.revokeSession('local_fixture');assert.equal((await f.media.handle(new Request(url))).status,404);const reminted=await f.media.mintImageUrl('local_fixture',f.file);assert.ok(reminted);assert.notEqual(reminted,url);const restored=await f.media.handle(new Request(reminted));assert.equal(restored.status,200);await restored.body.cancel();assert.equal((await f.media.handle(new Request(url))).status,404);f.media.dispose();assert.deepEqual(registrations[1],['remove','claude-media']);assert.equal((await f.media.handle(new Request(url))).status,404);assert.throws(()=>f.media.install(protocol),/disposed/);
 }finally{f.clean();}
});


test('a minted URL cannot follow a directory replaced with an external junction',async()=>{
 const f=fixture();try{const folder=path.join(f.cwd,'folder');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'image.png'),f.image);const url=await f.media.mintImageUrl('local_fixture',path.join(folder,'image.png'));assert.ok(url);
 const outside=path.join(f.root,'replacement');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'image.png'),f.image);fs.rmSync(folder,{recursive:true});fs.symlinkSync(outside,folder,process.platform==='win32'?'junction':'dir');assert.equal((await f.media.handle(new Request(url))).status,404);
 }finally{f.clean();}
});
