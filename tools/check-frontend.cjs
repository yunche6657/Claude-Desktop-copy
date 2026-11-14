'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function check(root=path.resolve(__dirname,'..')){
 const dir=path.join(root,'resources/ion-dist'),manifest=JSON.parse(fs.readFileSync(path.join(root,'resources/frontend-manifest.json'),'utf8'));
 const expected=new Set();
 for(const item of manifest.files){if(path.isAbsolute(item.path)||item.path.split(/[\\/]/).includes('..'))throw Error('Invalid manifest path');const file=path.join(dir,item.path);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid frontend asset: '+item.path);const data=fs.readFileSync(file);if(data.length!==item.size||crypto.createHash('sha256').update(data).digest('hex')!==item.sha256)throw Error('Frontend digest mismatch: '+item.path);expected.add(item.path);}
 function walk(d,rel=''){for(const e of fs.readdirSync(d,{withFileTypes:true})){const name=path.posix.join(rel,e.name);if(e.isSymbolicLink())throw Error('Frontend symlink: '+name);if(e.isDirectory())walk(path.join(d,e.name),name);else if(!expected.has(name))throw Error('Uninventoried asset: '+name);}}walk(dir);
 if(!expected.has('index.html'))throw Error('Frontend index missing');
 const boot=JSON.parse(fs.readFileSync(path.join(root,'resources/bootstrap-3p.json'),'utf8'));
 if(!boot.account||!boot.growthbook?.features||!boot.model_selector_config)throw Error('Bootstrap required structure missing');
 return {files:expected.size,bootstrap:'valid-structure',mode:'prebuilt-assets'};
}
if(require.main===module)console.log(JSON.stringify(check()));module.exports={check};
