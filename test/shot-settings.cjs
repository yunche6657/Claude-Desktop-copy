const { app, BrowserWindow } = require('electron');
if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;
const fs=require('fs'),os=require('os'),path=require('path');
let server;
app.whenReady().then(async()=>{
  const {createApp}=await import('../server.mjs');
  server=createApp({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'shot2-')),mode:'demo'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const win=new BrowserWindow({show:false,width:1936,height:1048,frame:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message',(_e,l,m)=>console.log('CONSOLE',m));
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const diag = await win.webContents.executeJavaScript(`(async()=>{
    const w=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<50&&!document.getElementById('connection').textContent.includes('演示');i++)await w(100);
    document.getElementById('settings').click();
    await w(200);
    document.querySelector('#account-menu .menu-row[data-menu=settings]').click();
    await w(500);
    return {
      dialogOpen: document.getElementById('dialog').open,
      railItems: [...document.querySelectorAll('.settings-item')].length,
      paneChildren: document.getElementById('settings-pane').children.length,
      title: document.querySelector('.pane-title')?.textContent,
      toggles: document.querySelectorAll('.toggle').length,
      selects: document.querySelectorAll('.pane-select').length,
    };
  })()`);
  console.log(JSON.stringify(diag));
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname,'../evidence/settings-modal.png'), img.toPNG());
  win.destroy(); server.closeAllConnections(); server.close(()=>app.exit(0));
}).catch(e=>{console.error(e);app.exit(1);});
