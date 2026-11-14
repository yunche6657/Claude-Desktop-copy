// Capture states and report renderer console errors so UI regressions are visible.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
let server;
app.whenReady().then(async()=>{
  const {createApp}=await import('../server.mjs');
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'code-desktop-states-'));
  server=createApp({dataDir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const win=new BrowserWindow({show:false,width:1936,height:1048,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const logs=[];
  win.webContents.on('console-message',(event,level,message)=>{
    logs.push({level,message});
    if(level>=2)console.log('RENDERER['+level+']: '+message);
  });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  await wait(900);
  const settle=()=>win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await settle();
  fs.writeFileSync(path.join(__dirname,'../evidence/state-welcome.png'),(await win.webContents.capturePage()).toPNG());
  const metrics=await win.webContents.executeJavaScript(`(()=>{
    const r=el=>{if(!el)return null;const b=el.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};};
    return {titlebar:r(document.querySelector('.titlebar')),sidebar:r(document.querySelector('.sidebar')),
      segmented:r(document.querySelector('.segmented')),pill:r(document.querySelector('.pill')),
      row:r(document.querySelector('.composer-row')),transcript:r(document.getElementById('messages')),
      main:r(document.querySelector('.main'))};
  })()`);
  console.log(JSON.stringify({ok:true,errors:logs.filter(l=>l.level>=2),...metrics}));
  win.destroy();server.closeAllConnections();server.close(()=>app.exit(0));
}).catch(error=>{console.error(error);if(server)server.close();app.exit(1);});
