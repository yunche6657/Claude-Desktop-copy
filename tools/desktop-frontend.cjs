'use strict';
const path=require('node:path'),fs=require('node:fs'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');console.log(require('./check-frontend.cjs').check(root));
const electron=require('electron');if(typeof electron!=='string'||!fs.existsSync(electron))throw Error('Run npm ci first');
const env={...process.env,CLAUDE_VIEW:'frontend',CLAUDE_FRONTEND_ROOT:path.join(root,'resources/ion-dist')};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,['.'],{cwd:root,env,stdio:'inherit',windowsHide:true});child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('exit',code=>{process.exitCode=code??1});
