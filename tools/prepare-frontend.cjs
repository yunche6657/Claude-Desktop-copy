'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readAsar}=require('../build/asar.cjs');
const root=path.resolve(__dirname,'..'),arg=process.argv.slice(2),source=arg[arg.indexOf('--from')+1];
if(!arg.includes('--from')||!source)throw Error('Usage: node tools/prepare-frontend.cjs --from <app.asar|ion-dist-directory>');
const input=path.resolve(source),target=path.join(root,'resources','ion-dist');
if(fs.existsSync(target))throw Error('Destination exists; move it aside before importing: '+target);
const files=new Map();
if(fs.statSync(input).isDirectory()){
 function walk(dir,rel=''){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const name=path.posix.join(rel,e.name),p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Source contains symlink: '+name);if(e.isDirectory())walk(p,name);else files.set(name,fs.readFileSync(p));}}walk(input);
}else{const archive=readAsar(input);for(const [name,data]of archive.files){const prefix='resources/ion-dist/';if(name.startsWith(prefix))files.set(name.slice(prefix.length),data);}}
if(!files.has('index.html'))throw Error('No frontend index.html found');
for(const name of files.keys())if(path.isAbsolute(name)||name.split(/[\\/]/).includes('..'))throw Error('Invalid asset path');
const temp=target+'.staging-'+crypto.randomUUID();fs.mkdirSync(temp,{recursive:true});
const inventory=[];for(const [name,data]of [...files].sort(([a],[b])=>a.localeCompare(b))){const out=path.join(temp,name);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,data);inventory.push({path:name,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});}
fs.renameSync(temp,target);
fs.writeFileSync(path.join(root,'resources','frontend-manifest.json'),JSON.stringify({format:1,kind:'prebuilt-assets',sourceCode:false,files:inventory},null,2)+'\n');
console.log(JSON.stringify({frontendFiles:inventory.length,destination:target,mode:'prebuilt-import'}));
