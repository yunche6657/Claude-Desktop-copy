import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {createPreviewHost,validUrl}=require('../desktop/preview-host.cjs');
function environment(options={}){
 const views=[],events=[],children=[];
 class Contents extends EventEmitter{
  destroyed=false;url='';title='';muted=false;entries=[];index=-1;
  session={setPermissionRequestHandler:fn=>this.permission=fn,protocol:{handlers:new Map(),isProtocolHandled(name){return this.handlers.has(name);},handle(name,fn){this.handlers.set(name,fn);},unhandle(name){this.handlers.delete(name);}}};
  isDestroyed(){return this.destroyed;}
  setWindowOpenHandler(fn){this.popup=fn;}
  setAudioMuted(v){this.muted=v;}
  isAudioMuted(){return this.muted;}
  getTitle(){return this.title;}
  getURL(){return this.url;}
  get mainFrame(){return {framesInSubtree:[{processId:1,routingId:1,url:this.url}]};}
  async loadURL(url){this.emit('did-start-loading');if(url.includes('load-failure'))throw new Error('load failed');this.url=url;this.title='Page '+url;this.entries=this.entries.slice(0,this.index+1);this.entries.push(url);this.index++;this.emit('did-navigate',{},url,200,'OK');this.emit('did-stop-loading');}
  canGoBack(){return this.index>0;}
  canGoForward(){return this.index<this.entries.length-1;}
  goBack(){this.url=this.entries[--this.index];this.emit('did-navigate',{},this.url);}
  goForward(){this.url=this.entries[++this.index];this.emit('did-navigate',{},this.url);}
  enableDeviceEmulation(options){this.emulation=options;}
  disableDeviceEmulation(){this.emulation=null;}
  reload(){this.reloaded=true;}
  focus(){this.focused=true;}
  async capturePage(){return {isEmpty:()=>false,getSize:()=>({width:1024,height:768}),resize(){return this;},toPNG:()=>Buffer.from('PNG'+this.url),toJPEG:()=>Buffer.from('JPEG'+this.url)};}
  close(){this.destroyed=true;this.emit('destroyed');}
 }
 const win={isDestroyed:()=>false,contentView:{addChildView:v=>children.push(v),removeChildView:v=>{const at=children.indexOf(v);if(at>=0)children.splice(at,1);}}};
 const host=createPreviewHost({createView:config=>{const view={config,webContents:new Contents(),setBounds:b=>view.bounds=b,setVisible:v=>view.visible=v,setBackgroundColor:c=>view.color=c};options.configureContents?.(view.webContents);views.push(view);return view;},getMainWindow:()=>win,emit:(...args)=>events.push(args),...options});
 return {host,views,events,children};
}

test('view creation uses sandboxed isolated preferences and success requires loaded real contents',async()=>{
 const e=environment();try{const r=await e.host.createPreview('server','http://127.0.0.1:4123/a','cwd','session');assert.deepEqual(r,{previewId:'server',tabId:'seed'});assert.equal(e.views.length,1);assert.equal(e.views[0].config.webPreferences.sandbox,true);assert.equal(e.views[0].config.webPreferences.contextIsolation,true);assert.equal(e.views[0].config.webPreferences.nodeIntegration,false);assert.equal(e.host.getPreviewTabs('server').tabs[0].origin,'http://127.0.0.1:4123');assert.equal(e.host.getPreviewTabs('server').tabs[0].loading,false);assert.equal(await e.host.createPreview('failed','http://127.0.0.1/load-failure'),null);assert.equal(e.host.getAllSessionPreviewTabs().length,1);}
 finally{e.host.dispose();}
});

test('actual contents factory failures never manufacture tab IDs or ready state',async()=>{
 const h=createPreviewHost({createView:()=>{throw new Error('renderer unavailable');}});try{assert.equal(await h.createPreview('server','http://localhost'),null);assert.deepEqual(h.getAllSessionPreviewTabs(),[]);assert.deepEqual(h.getPreviewTabs('missing'),{tabs:[],activeTabId:'seed'});assert.equal(h.openPreviewTab('missing'),null);assert.equal(h.getPreviewNavState('missing'),null);}finally{h.dispose();}
});

test('navigation, positional events and history follow actual contents',async()=>{
 const e=environment();try{await e.host.createPreview('s','http://localhost/a');assert.equal(await e.host.navigatePreview('s','http://localhost/b'),true);assert.deepEqual(e.host.getPreviewNavState('s'),{canGoBack:true,canGoForward:false});assert.equal(e.host.goBack('s'),true);assert.equal(e.host.getPreviewUrl('s'),'http://localhost/a');assert.equal(e.host.goForward('s'),true);assert.equal(e.host.getPreviewUrl('s'),'http://localhost/b');assert.equal(e.host.refreshPreview('s'),true);assert.equal(e.views[0].webContents.reloaded,true);assert.ok(e.events.some(x=>x[0]==='previewUrlChanged'&&x[1]==='s'&&x[2]==='http://localhost/b'));assert.ok(e.events.some(x=>x[0]==='previewTabsChanged'&&Array.isArray(x[2])&&x[3]==='seed'));}
 finally{e.host.dispose();}
});

test('tabs are bounded, ordered, muted, closed, reopened and destroyed with their contents',async()=>{
 const e=environment({maxTabs:3});try{await e.host.createPreview('s','http://localhost/a');const a=e.host.openPreviewTab('s'),b=e.host.openPreviewTab('s');assert.ok(a&&b&&a!==b);assert.equal(e.host.openPreviewTab('s'),null);assert.equal(e.host.reorderPreviewTab('s',b,0),true);assert.equal(e.host.getPreviewTabs('s').tabs[0].tabId,b);assert.equal(e.host.setPreviewMuted('s',true),true);assert.ok(e.host.getPreviewTabs('s').tabs.every(t=>t.muted));assert.equal(e.host.closePreviewTab('s',b),true);assert.equal(e.views[2].webContents.isDestroyed(),true);assert.ok(e.host.reopenClosedPreviewTab('s'));assert.equal(e.host.closeAllPreviewTabs('s'),true);assert.equal(e.host.getPreviewTabs('s').tabs.length,1);assert.equal(e.host.destroyPreview('s'),true);assert.ok(e.views.every(v=>v.webContents.isDestroyed()));assert.equal(e.host.destroyPreview('s'),false);}
 finally{e.host.dispose();}
});

test('mounting honors claim ownership, bounds and missing host instead of reporting a shown view',async()=>{
 const e=environment();try{await e.host.createPreview('s','http://localhost');const bounds={x:20,y:30,width:640,height:480};assert.equal(e.host.showPreview('s',bounds,'owner'),true);assert.equal(e.children.length,1);assert.deepEqual(e.views[0].bounds,bounds);assert.equal(e.host.showPreview('s',bounds,'foreign'),false);assert.equal(e.host.hidePreview('s','foreign'),false);assert.equal(e.host.hidePreview('s','owner'),true);assert.equal(e.children.length,0);assert.equal(e.host.showPreview('s',{...bounds,width:-1}),false);}
 finally{e.host.dispose();}
 const missing=environment({getMainWindow:()=>null});try{await missing.host.createPreview('s','http://localhost');assert.equal(missing.host.showPreview('s',{x:0,y:0,width:640,height:480}),false);}finally{missing.host.dispose();}
});

test('capture returns actual image bytes and changed-only returns null for an unchanged frame',async()=>{
 const e=environment();try{await e.host.createPreview('s','http://localhost/a');assert.equal(Buffer.from(await e.host.capturePreviewScreenshot('s'),'base64').toString(),'PNGhttp://localhost/a');assert.equal(Buffer.from(await e.host.capturePreviewScreenshot('s','seed'),'base64').toString(),'JPEGhttp://localhost/a');assert.ok(await e.host.capturePreviewScreenshotIfChanged('s'));assert.equal(await e.host.capturePreviewScreenshotIfChanged('s'),null);assert.ok(await e.host.capturePreviewScreenshotIfChanged('s',true));assert.equal(await e.host.capturePreviewScreenshot('unknown'),null);}
 finally{e.host.dispose();}
});

test('URL policy and redirects cannot silently bypass host admission',async()=>{
 const e=environment({isUrlAllowed:url=>url.startsWith('http://127.0.0.1')||url==='about:blank'});try{assert.equal(validUrl('file:///C:/private'),false);assert.equal(validUrl('javascript:alert(1)'),false);assert.equal(validUrl('https://user:password@example.invalid'),false);assert.equal(await e.host.createPreview('bad','https://example.invalid'),null);await e.host.createPreview('s','http://127.0.0.1:4000');assert.equal(await e.host.navigatePreview('s','https://example.invalid'),false);let prevented=false;e.views[0].webContents.emit('will-redirect',{preventDefault(){prevented=true;}},'file:///C:/private');assert.equal(prevented,true);assert.deepEqual(e.views[0].webContents.popup({url:'https://example.invalid'}),{action:'deny'});assert.equal(e.host.getPreviewTabs('s').tabs.length,1);}
 finally{e.host.dispose();}
});

test('session teardown and host disposal release every isolated contents and prevent new previews',async()=>{
 const e=environment();await e.host.createPreview('a','http://localhost/a','cwd','session');await e.host.createPreview('b','http://localhost/b','cwd','other');assert.equal(e.host.teardownRemoteSessionPreview('session'),true);assert.equal(e.host.getAllSessionPreviewTabs().length,1);e.host.dispose();e.host.dispose();assert.ok(e.views.every(v=>v.webContents.isDestroyed()));assert.equal(await e.host.createPreview('c','http://localhost'),null);assert.deepEqual(e.host.getAllSessionPreviewTabs(),[]);
});


test('viewport emulation is reflected only after real contents accepts it and can be cleared',async()=>{
 const e=environment();try{await e.host.createPreview('s','http://localhost');assert.equal(e.host.setPreviewViewport('s',640,480),true);assert.deepEqual(e.host.getPreviewTabs('s').tabs[0].emulatedViewport,{width:640,height:480,setBy:'user'});assert.equal(e.views[0].webContents.emulation.viewSize.width,640);assert.equal(e.host.setPreviewViewport('s',0,480),false);assert.equal(e.host.clearPreviewViewport('s'),true);assert.equal(e.host.getPreviewTabs('s').tabs[0].emulatedViewport,null);assert.equal(e.views[0].webContents.emulation,null);}finally{e.host.dispose();}
});

test('a validated hide releases ownership for React remount while stale owners cannot hide the new pane',async()=>{
 const e=environment();try{
  await e.host.createPreview('s','http://localhost');const bounds={x:20,y:73,width:750,height:898};
  assert.equal(e.host.showPreview('s',bounds,'react-old','window-a'),true);
  assert.equal(e.host.hidePreview('s','foreign','window-a'),false);
  assert.equal(e.host.showPreview('s',bounds,'react-new','window-a'),false);
  assert.equal(e.host.hidePreview('s','react-old','stale-window'),false);
  assert.equal(e.host.showPreview('s',bounds,'react-new','window-a'),false);
  assert.equal(e.host.hidePreview('s','react-old','window-a'),true);
  assert.equal(e.children.length,0);assert.equal(e.views[0].visible,false);
  assert.equal(e.host.showPreview('s',bounds,'react-new','window-a'),true);
  assert.equal(e.children.length,1);assert.equal(e.views[0].visible,true);
  assert.equal(e.host.hidePreview('s','react-old','window-a'),false);
  assert.equal(e.children.length,1);
  assert.equal(e.host.hidePreview('s','react-new','window-a'),true);
  assert.equal(e.host.showPreview('s',bounds,'react-third','window-b'),true);
  assert.equal(e.host.hidePreview('s','react-third','window-a'),false);
  assert.equal(e.host.hidePreview('s','react-third','window-b'),true);
 }finally{e.host.dispose();}
});


function readEnvironment(options={}) {
 const commands=[];
 const e=environment({readToolsEnabled:true,authorizeRead:()=>true,...options,configureContents:wc=>{
  const tools=new EventEmitter();tools.attached=false;tools.isAttached=()=>tools.attached;tools.attach=()=>{tools.attached=true;};tools.detach=()=>{tools.attached=false;};
  tools.sendCommand=async(method,args)=>{commands.push({method,args});
   if(method==='Accessibility.getFullAXTree')return{nodes:[{nodeId:'a',role:{value:'RootWebArea'},name:{value:'REAL_AX_PAGE'},childIds:['b']},{nodeId:'b',role:{value:'button'},name:{value:'Actual button'}}]};
   if(method==='DOM.getDocument')return{root:{nodeId:1}};
   if(method==='DOM.querySelector')return{nodeId:args.selector==='#absent'?0:2};
   if(method==='DOM.describeNode')return{node:{nodeName:'BUTTON',attributes:['id','actual','class','real-button']}};
   if(method==='CSS.getComputedStyleForNode')return{computedStyle:[{name:'color',value:'rgb(1, 2, 3)'},{name:'display',value:'block'}]};
   if(method==='DOM.getBoxModel')return{model:{content:[10,20,110,20,110,60,10,60]}};
   if(method==='Runtime.evaluate')return{result:{value:'DOM_ACTUAL_TEXT'}};
   return{};
  };
  wc.debugger=tools;options.configureContents?.(wc);
 }});
 return{...e,commands};
}

test('native read-tier rejects ordinary dev servers, absent feature and missing consent before returning page data',async()=>{
 const e=readEnvironment();try{await e.host.createPreview('ordinary-dev-server','http://localhost');assert.equal(await e.host.previewSnapshot('ordinary-dev-server'),null);assert.equal(await e.host.previewInspect('ordinary-dev-server','button'),null);assert.equal(await e.host.previewConsoleLogs('ordinary-dev-server'),null);}finally{e.host.dispose();}
 const disabled=readEnvironment({readToolsEnabled:false});try{await disabled.host.createPreview('preview-remote-fixture','http://localhost');assert.equal(await disabled.host.previewSnapshot('preview-remote-fixture'),null);}finally{disabled.host.dispose();}
 const denied=readEnvironment({authorizeRead:()=>false});try{await denied.host.createPreview('preview-remote-fixture','http://localhost');assert.equal(await denied.host.previewInspect('preview-remote-fixture','button'),null);assert.ok(denied.commands.every(x=>x.method!=='DOM.getDocument'));}finally{denied.host.dispose();}
});

test('console events carry typed data, errors filter and clear apply only after read authorization',async()=>{
 const e=readEnvironment();try{await e.host.createPreview('preview-remote-fixture','http://localhost');const tools=e.views[0].webContents.debugger;tools.emit('message',{},'Runtime.consoleAPICalled',{type:'log',args:[{value:'ACTUAL_CONSOLE'},{value:12}],timestamp:123});tools.emit('message',{},'Runtime.consoleAPICalled',{type:'error',args:[{value:'ACTUAL_ERROR'}],timestamp:124});const rows=await e.host.previewConsoleLogs('preview-remote-fixture');assert.deepEqual(rows,[{level:'log',text:'ACTUAL_CONSOLE 12',timestamp:123},{level:'error',text:'ACTUAL_ERROR',timestamp:124}]);rows[0].text='MUTATED';assert.equal((await e.host.previewConsoleLogs('preview-remote-fixture'))[0].text,'ACTUAL_CONSOLE 12');assert.deepEqual(await e.host.previewConsoleLogs('preview-remote-fixture',{onlyErrors:true,clear:true}),[{level:'error',text:'ACTUAL_ERROR',timestamp:124}]);assert.deepEqual(await e.host.previewConsoleLogs('preview-remote-fixture'),[]);assert.equal(await e.host.previewConsoleLogs('preview-remote-fixture',{clear:'yes'}),null);}finally{e.host.dispose();}
});

test('accessibility snapshot and selector inspection come from actual protocol responses with native shapes',async()=>{
 const e=readEnvironment();try{await e.host.createPreview('preview-remote-fixture','http://localhost');const snapshot=await e.host.previewSnapshot('preview-remote-fixture');assert.equal(snapshot,'[1] RootWebArea: "REAL_AX_PAGE"\n  [2] button: "Actual button"');const info=await e.host.previewInspect('preview-remote-fixture','#actual',['color']);assert.deepEqual(info,{found:true,info:{tagName:'button',text:'DOM_ACTUAL_TEXT',className:'real-button',id:'actual',styles:{color:'rgb(1, 2, 3)'},boundingBox:{x:10,y:20,width:100,height:40}}});assert.deepEqual(await e.host.previewInspect('preview-remote-fixture','#absent'),{found:false});assert.equal(e.commands.at(-1).method,'DOM.disable');}finally{e.host.dispose();}
});

test('page navigation or changed frame state during authorization withholds read results',async()=>{
 let current;
 const e=readEnvironment({authorizeRead:()=>{current.emit('did-start-navigation');return true;}});try{await e.host.createPreview('preview-remote-fixture','http://localhost');current=e.views[0].webContents;assert.equal(await e.host.previewSnapshot('preview-remote-fixture'),null);assert.ok(e.commands.every(x=>x.method!=='Accessibility.getFullAXTree'));}finally{e.host.dispose();}
 const during=readEnvironment({configureContents:wc=>{const original=wc.debugger.sendCommand;wc.debugger.sendCommand=async(method,args)=>{const result=await original(method,args);if(method==='Accessibility.getFullAXTree')wc.emit('did-frame-navigate');return result;};}});try{await during.host.createPreview('preview-remote-fixture','http://localhost');assert.equal(await during.host.previewSnapshot('preview-remote-fixture'),null);}finally{during.host.dispose();}
});

test('inspection serializes selectors as a string and never executes selector text as code',async()=>{
 const e=readEnvironment();try{await e.host.createPreview('preview-remote-fixture','http://localhost');const selector='#x\" ); globalThis.unsafe=true; //';await e.host.previewInspect('preview-remote-fixture',selector);const expression=e.commands.find(x=>x.method==='Runtime.evaluate').args.expression;assert.ok(expression.startsWith('document.querySelector('+JSON.stringify(selector)+')'));assert.equal(await e.host.previewInspect('preview-remote-fixture','button',[42]),null);}finally{e.host.dispose();}
});


test('console URL redaction follows the recovered native helper and keeps ordinary text intact',async()=>{
 const e=readEnvironment();try{await e.host.createPreview('preview-remote-fixture','http://localhost');const tools=e.views[0].webContents.debugger;tools.emit('message',{},'Runtime.consoleAPICalled',{type:'log',args:[{value:'https://user:password@example.invalid/path?api_key=SYNTHETIC_SECRET_359&item=blue#nonce=fake_nonce_359'}],timestamp:125});const rows=await e.host.previewConsoleLogs('preview-remote-fixture');assert.equal(rows.length,1);assert.ok(rows[0].text.includes('api_key=REDACTED'));assert.ok(rows[0].text.includes('item=blue'));assert.ok(!rows[0].text.includes('SYNTHETIC_SECRET_359'));assert.ok(!rows[0].text.includes('user:password'));assert.ok(!rows[0].text.includes('fake_nonce_359'));}finally{e.host.dispose();}
});

test('read-tier debugger ownership does not break screenshot/color or detach another client',async()=>{
 const e=readEnvironment();try{await e.host.createPreview('preview-remote-fixture','http://localhost');const tools=e.views[0].webContents.debugger;assert.equal(tools.isAttached(),true);assert.equal(await e.host.setPreviewColorScheme('preview-remote-fixture','dark'),true);assert.equal(tools.isAttached(),true);assert.ok(await e.host.capturePreviewScreenshot('preview-remote-fixture'));assert.equal(tools.isAttached(),true);e.host.dispose();assert.equal(tools.isAttached(),false);}finally{e.host.dispose();}
 const foreign=readEnvironment({configureContents:wc=>{wc.debugger.attached=true;}});try{await foreign.host.createPreview('preview-remote-fixture','http://localhost');assert.equal(await foreign.host.previewSnapshot('preview-remote-fixture'),null);foreign.host.dispose();assert.equal(foreign.views[0].webContents.debugger.isAttached(),true);}finally{foreign.host.dispose();}
});


test('static HTML content creates real host metadata and revoke-on-destroy protocol binding',async()=>{
 let updates=0;const e=environment({getSession:id=>id==='html-session'?{cwd:process.cwd()}:null,onHtmlPreviewsChanged:()=>updates++});try{const id=await e.host.loadHtmlPreviewContent('<h1>CONTENT_REAL</h1>','generated.html',false,process.cwd(),'html-session');assert.ok(id.startsWith('html-preview-'));assert.equal(e.views.length,1);assert.ok(e.views[0].webContents.getURL().startsWith('claude-preview://'));assert.equal(e.host.getHtmlPreviews()[0].sessionId,'html-session');assert.equal(e.host.getHtmlPreviews()[0].status,'running');assert.deepEqual(e.host.getAllSessionPreviewTabs(),[]);const handler=e.views[0].webContents.session.protocol.handlers.get('claude-preview');const url=e.views[0].webContents.getURL();assert.equal((await handler(new Request(url))).status,200);assert.ok(updates>0);assert.equal(e.host.destroyPreview(id),true);assert.equal((await handler(new Request(url))).status,404);assert.deepEqual(e.host.getHtmlPreviews(),[]);assert.equal(e.host.setArtifactPaneHost('anything'),false);assert.equal(await e.host.loadClaudePagePreview('https://claude.ai/code/artifact/foo',process.cwd(),'html-session'),null);await assert.rejects(e.host.loadHtmlPreviewContent('x','a.html',false,process.cwd(),'missing'),/Session not found/);}finally{e.host.dispose();}
});


test('static preview replacement follows session scope and bounded cross-scope retention',async()=>{
 const e=environment({getSession:()=>({cwd:process.cwd()})});try{const create=sid=>e.host.loadHtmlPreviewContent('<h1>'+sid+'</h1>','generated.html',false,process.cwd(),sid);const first=await create('same');const firstView=e.views.at(-1);const second=await create('same');assert.notEqual(first,second);assert.equal(firstView.webContents.isDestroyed(),true);assert.equal(e.host.getHtmlPreviews().length,1);for(const sid of ['a','b','c','d'])await create(sid);assert.equal(e.host.getHtmlPreviews().length,4);assert.ok(e.host.getHtmlPreviews().every(row=>row.sessionId!=='same'));}finally{e.host.dispose();}
});


test('read-tier reauthorizes after CDP so policy revocation with unchanged navigation withholds snapshot and inspect',async()=>{
 for(const operation of ['snapshot','inspect']){
  let revoked=false;const e=readEnvironment({authorizeRead:()=>!revoked,configureContents:wc=>{const original=wc.debugger.sendCommand;wc.debugger.sendCommand=async(method,args)=>{const response=await original(method,args);if(method===(operation==='snapshot'?'Accessibility.getFullAXTree':'Runtime.evaluate'))revoked=true;return response;};}});
  try{await e.host.createPreview('preview-remote-fixture','http://localhost');const result=operation==='snapshot'?await e.host.previewSnapshot('preview-remote-fixture'):await e.host.previewInspect('preview-remote-fixture','#actual');assert.equal(result,null);assert.equal(revoked,true);}finally{e.host.dispose();}
 }
});

test('post-read denial never clears logs before policy reauthorization succeeds',async()=>{
 let calls=0,denySecond=true;const seen=[];const e=readEnvironment({authorizeRead:stamp=>{seen.push(stamp);calls++;return !denySecond||calls===1;}});try{await e.host.createPreview('preview-remote-fixture','http://localhost');e.views[0].webContents.debugger.emit('message',{},'Runtime.consoleAPICalled',{type:'error',args:[{value:'KEEP_UNTIL_AUTHORIZED'}],timestamp:200});assert.equal(await e.host.previewConsoleLogs('preview-remote-fixture',{clear:true}),null);assert.equal(calls,2);assert.deepEqual(seen[0],seen[1]);denySecond=false;const rows=await e.host.previewConsoleLogs('preview-remote-fixture');assert.equal(rows[0].text,'KEEP_UNTIL_AUTHORIZED');assert.equal((await e.host.previewConsoleLogs('preview-remote-fixture',{clear:true}))[0].text,'KEEP_UNTIL_AUTHORIZED');assert.deepEqual(await e.host.previewConsoleLogs('preview-remote-fixture'),[]);}finally{e.host.dispose();}
});

test('internal read stamp matches authorization inputs without executing page reads or bypassing the feature gate',async()=>{
 let enabled=true,received;const e=readEnvironment({readToolsEnabled:()=>enabled,authorizeRead:stamp=>{received=stamp;return true;}});try{await e.host.createPreview('preview-remote-fixture','http://localhost');const before=e.commands.length;const stamp=e.host.getReadStamp('preview-remote-fixture','seed');assert.equal(e.commands.length,before);assert.equal(stamp.serverId,'preview-remote-fixture');assert.equal(stamp.tabId,'seed');assert.equal(stamp.url,'http://localhost');assert.equal(stamp.frames[0].url,'http://localhost');await e.host.previewSnapshot('preview-remote-fixture');assert.deepEqual(stamp,received);stamp.frames[0].url='MUTATED';assert.equal(e.host.getReadStamp('preview-remote-fixture').frames[0].url,'http://localhost');enabled=false;assert.equal(e.host.getReadStamp('preview-remote-fixture'),null);assert.equal(e.host.getReadStamp('ordinary-dev-server'),null);}finally{e.host.dispose();}
});


test('logs arriving while post-read policy is checked survive a successful clear',async()=>{
 let calls=0,tools;const e=readEnvironment({authorizeRead:()=>{calls++;if(calls===2)tools.emit('message',{},'Runtime.consoleAPICalled',{type:'log',args:[{value:'ARRIVED_DURING_RECHECK'}],timestamp:302});return true;}});try{await e.host.createPreview('preview-remote-fixture','http://localhost');tools=e.views[0].webContents.debugger;tools.emit('message',{},'Runtime.consoleAPICalled',{type:'log',args:[{value:'CAPTURED_BEFORE_RECHECK'}],timestamp:301});assert.equal((await e.host.previewConsoleLogs('preview-remote-fixture',{clear:true}))[0].text,'CAPTURED_BEFORE_RECHECK');const remaining=await e.host.previewConsoleLogs('preview-remote-fixture');assert.deepEqual(remaining,[{level:'log',text:'ARRIVED_DURING_RECHECK',timestamp:302}]);}finally{e.host.dispose();}
});


test('gate-off file fallback loads authorized raw HTML and never installs a directory protocol',async()=>{
 const base=path.resolve('.tmp/raw-host-tests');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'case-'));const source=path.join(dir,'source.html');const html='<h1>RAW_LOADED</h1><script>globalThis.INLINE=true</script>';fs.writeFileSync(source,html);const e=environment({getSession:()=>({cwd:dir}),authorizeHtmlFile:()=>true,interactiveHtmlEnabled:false});try{const id=await e.host.loadHtmlPreview(source,'session',dir);assert.ok(id.startsWith('html-preview-'));assert.equal(e.views[0].webContents.getURL(),'data:text/html;charset=utf-8,'+encodeURIComponent(html));assert.equal(e.views[0].webContents.session.protocol.handlers.size,0);assert.equal(e.host.getHtmlPreviews()[0].cwd,dir);assert.ok(!Object.hasOwn(e.host.getHtmlPreviews()[0],'filePath'));assert.equal(await e.host.navigatePreview(id,'http://localhost/external'),false);assert.equal(e.host.getPreviewTabs(id).tabs[0].origin,'');e.host.destroyPreview(id);assert.equal(e.views[0].webContents.isDestroyed(),true);}finally{e.host.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
