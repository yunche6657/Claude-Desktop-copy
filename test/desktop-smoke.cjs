const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
let server;
app.whenReady().then(async()=>{
 const {createApp}=await import('../server.mjs');
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'code-desktop-smoke-'));
 server=createApp({dataDir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const win=new BrowserWindow({show:false,width:1936,height:1048,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await win.loadURL(`http://127.0.0.1:${server.address().port}`);
 const result=await win.webContents.executeJavaScript(`(async()=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<50&&!document.getElementById('connection').textContent.includes('演示');i++)await wait(100);
  // Drive the idle composer, which is the surface a user actually types into on
  // the welcome screen. The in-conversation composer is hidden until a session
  // exists, so submitting it directly would do nothing.
  const hero=document.getElementById('hero-prompt');
  hero.value='桌面冒烟测试';hero.dispatchEvent(new Event('input'));
  document.getElementById('hero-send').click();
  for(let i=0;i<100&&!document.getElementById('run-status').textContent.includes('已完成');i++)await wait(100);
  const messages=[...document.querySelectorAll('.message')].map(e=>e.textContent);
  if(messages.length!==2||!messages[1].includes('Demo'))throw Error('Conversation smoke failed: '+JSON.stringify(messages));
  document.getElementById('theme').click();
  if(!document.body.classList.contains('dark'))throw Error('Theme switch failed');
  document.getElementById('theme').click();
  return {messages:messages.length,status:document.getElementById('run-status').textContent,themeToggle:true,assistantText:document.querySelector('.message.assistant div')?.textContent||''};
 })()`);
 await new Promise(r=>setTimeout(r,1200));
 await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const image=await win.webContents.capturePage();fs.writeFileSync(path.join(__dirname,'../evidence/desktop-smoke.png'),image.toPNG());
 console.log(JSON.stringify({ok:true,...result,dataDir}));win.destroy();server.closeAllConnections();server.close(()=>app.exit(0));
}).catch(error=>{console.error(error);if(server)server.close();app.exit(1);});
