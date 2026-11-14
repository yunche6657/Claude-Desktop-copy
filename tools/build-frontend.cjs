'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),source=path.join(root,'renderer'),dest=path.join(root,'dist','frontend');
const stage=dest+'.staging-'+crypto.randomUUID();fs.mkdirSync(stage,{recursive:true});const files=[];
function walk(dir,rel=''){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const name=path.posix.join(rel,e.name),input=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Source symlinks are not supported');if(e.isDirectory())walk(input,name);else{const data=fs.readFileSync(input),out=path.join(stage,name);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,data);files.push({path:name,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});}}}walk(source);
fs.writeFileSync(path.join(stage,'build-manifest.json'),JSON.stringify({format:1,kind:'independent-renderer',files},null,2)+'\n');
const previous=dest+'.previous-'+crypto.randomUUID();
if(fs.existsSync(dest))fs.renameSync(dest,previous);
try{fs.renameSync(stage,dest);}catch(error){if(fs.existsSync(previous))fs.renameSync(previous,dest);throw error;}
if(fs.existsSync(previous))fs.rmSync(previous,{recursive:true});
console.log(JSON.stringify({destination:dest,files:files.length}));
