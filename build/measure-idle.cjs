const { app, BrowserWindow } = require('electron');
if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;
const fs=require('fs'),os=require('os'),path=require('path');
let server;
app.whenReady().then(async()=>{
  const {createApp}=await import('../server.mjs');
  server=createApp({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'meas-')),mode:'demo'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const win=new BrowserWindow({show:false,width:1936,height:1048,frame:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const out = await win.webContents.executeJavaScript(`(async()=>{
    const w=ms=>new Promise(r=>setTimeout(r,ms)); await w(900);
    const r = s => { const n=document.querySelector(s); if(!n) return null; const b=n.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}; };
    const cs = s => { const n=document.querySelector(s); if(!n) return null; const c=getComputedStyle(n); return {bg:c.backgroundColor,color:c.color,border:c.borderColor,radius:c.borderRadius,font:c.fontFamily,size:c.fontSize,weight:c.fontWeight}; };
    return {
      titlebar: r('.titlebar'),
      sidebar: r('.sidebar'),
      hero: r('.hero-composer'),
      heroTitle: r('.welcome-title'),
      ideas: r('.ideas'),
      titleStyle: cs('.welcome-title'),
      heroStyle: cs('.hero-composer'),
      bodyStyle: cs('body'),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    };
  })()`);
  console.log(JSON.stringify(out,null,1));
  win.destroy(); server.closeAllConnections(); server.close(()=>app.exit(0));
}).catch(e=>{console.error(e);app.exit(1);});
