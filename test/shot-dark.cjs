const { app, BrowserWindow } = require('electron');
if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;
const fs=require('fs'),os=require('os'),path=require('path');
let server;
app.whenReady().then(async()=>{
  const {createApp}=await import('../server.mjs');
  server=createApp({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'dark-')),mode:'demo'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const win=new BrowserWindow({show:false,width:1936,height:1048,frame:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const info = await win.webContents.executeJavaScript(`(async()=>{
    const w=ms=>new Promise(r=>setTimeout(r,ms)); await w(900);
    document.body.classList.add('dark'); await w(400);
    const cs=s=>{const n=document.querySelector(s);const c=getComputedStyle(n);return {bg:c.backgroundColor,color:c.color,border:c.borderColor};};
    return {body:cs('body'), sidebar:cs('.sidebar'), hero:cs('.hero-composer'), title:cs('.welcome-title')};
  })()`);
  console.log(JSON.stringify(info,null,1));
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname,'../evidence/state-dark.png'), img.toPNG());
  win.destroy(); server.closeAllConnections(); server.close(()=>app.exit(0));
}).catch(e=>{console.error(e);app.exit(1);});
