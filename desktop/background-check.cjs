'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Explicitly requested background acceptance for the actual packaged entry point.
// No pointer/keyboard input, native presentation, or writes to the live user workspace.
async function runBackgroundCheck({ app, win, appMenu, cliGovernor, previewActivation, getActiveCcbProcesses, getCcbRuntimeInfo, createResourceProofBackend, getWarmLifecycleState, evictResourceProofSession, getMainFeatureProof, settleMainFeatures, proveHybridSlotStorage }) {
  const out = process.env.CLAUDE_CHECK_OUT;
  const phase = process.env.CLAUDE_CHECK_PHASE || 'seed';
  const marker = 'PACKAGED_RESTART_331_OK';
  if (!out || !path.isAbsolute(out)) { app.exit(2); return; }
  const report = { phase, pid: process.pid, executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged };
  const write = () => {
    try {
      fs.writeFileSync(path.join(out, phase + '.json'), JSON.stringify(report, null, 2));
      return true;
    } catch (error) {
      console.error('[background-check] report write failed:', error.code || 'write_error');
      return false;
    }
  };
  // The sweep phase opens every stored session, so it needs more than the default. Keep the
  // shorter budget for every other phase: a hang there should still fail fast.
  const deadline = phase === 'history' ? 180000 : phase.startsWith('model-switch') ? 120000 : phase === 'git' ? 80000 : 60000;
  const watchdog = setTimeout(() => { report.error = 'background acceptance deadline'; write(); app.exit(1); }, deadline);
  try {
    const ev = s => win.webContents.executeJavaScript(s);
    const verifyDefaultEntry = async sid => {
      if (process.env.CLAUDE_PROOF_DEFAULT_ENTRY !== '1') return;
      const session = await ev(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(sid)})`);
      const runtime = getCcbRuntimeInfo();
      report.defaultEntry = { ...runtime, backend: session.kernelBackend, sessionModel: session.model,
        kernelOverride: process.env.CLAUDE_AGENT_KERNEL || null,
        adapterOverride: process.env.CLAUDE_CCB_GATEWAY_ADAPTER || null,
        prefixOverride: process.env.CLAUDE_CCB_GATEWAY_SYSTEM_PREFIX || null };
      assert.equal(session.kernelBackend, 'ccb');
      assert.equal(runtime.selection.id, 'ccb'); assert.equal(runtime.selection.requested, null);
      assert.equal(report.defaultEntry.kernelOverride, null); assert.equal(report.defaultEntry.adapterOverride, null); assert.equal(report.defaultEntry.prefixOverride, null);
      assert.equal(runtime.adapter, 'system-first'); assert.ok(['workspace','deployment'].includes(runtime.source));
      assert.equal(session.model, runtime.model);
      const bootstrap = await ev("fetch('app://localhost/edge-api/bootstrap').then(response=>response.json()).then(data=>data.model_selector_state.map(row=>row.model))");
      report.defaultEntry.bootstrapModels = bootstrap;
      assert.ok(bootstrap.length > 0 && bootstrap.every(model => model === runtime.model));
    };

    await sleep(2000);
    assert.equal(win.isVisible(), false);
    assert.equal(win.isFocusable(), false);
    report.visible = win.isVisible();
    report.model = process.env.CLAUDE_AGENT_MODEL;
    if (phase === 'main-features') {
      await require('./background-main-features-check.cjs').runMainFeaturesCheck({ report, ev, getMainFeatureProof, settleMainFeatures, proveHybridSlotStorage });
      report.ok = true;
      if (!write()) throw new Error('main feature proof report write failed');
      clearTimeout(watchdog); app.quit(); return;
    }
    if(phase==='session-pause'){
      await require('./background-session-pause-check.cjs').runSessionPauseCheck({report,ev,evictResourceProofSession,getActiveCcbProcesses});
      report.mainFeatures = getMainFeatureProof();
      assert.equal(report.mainFeatures.mode, '3p');
      assert.equal(report.mainFeatures.sourceKind, 'static');
      assert.equal(report.mainFeatures.staticCount, 29);
      assert.equal(report.mainFeatures.idleTimeout, 0);
      report.checks.mainStaticPolicyAndIdleReader = true;
      report.ok=true;write();clearTimeout(watchdog);app.quit();return;
    }
    if(phase==='session-loops'){
      await require('./background-session-loops-check.cjs').runSessionLoopsCheck({report,ev,getActiveCcbProcesses,win,evictResourceProofSession});
      report.ok=true;write();clearTimeout(watchdog);app.quit();return;
    }
    if(phase==='visibility'){
      await require('./background-visibility-check.cjs').runVisibilityCheck({report,ev,getWarmLifecycleState,evictResourceProofSession,getActiveCcbProcesses});
      report.ok=true;write();clearTimeout(watchdog);app.quit();return;
    }
    if(phase==='resources'){
      await require('./background-resource-check.cjs').runResourceCheck({report,ev,createResourceProofBackend,getActiveCcbProcesses});
      report.ok=true;write();clearTimeout(watchdog);app.quit();return;
    }
    if(['window-quit-seed','window-quit-restore'].includes(phase)){
      await require('./background-window-quit-check.cjs').runWindowQuitCheck({phase,report,ev,win,screen:require('electron').screen,getActiveCcbProcesses});
      report.ok=true;write();clearTimeout(watchdog);app.quit();return;
    }
    if (['profile-apply', 'profile-relaunched'].includes(phase)) {
      const status=await require('./background-profile-check.cjs').runProfileCheck({phase,out,report,ev,getActiveCcbProcesses,getCcbRuntimeInfo,app,win});
      if(status==='relaunching'){clearTimeout(watchdog);return;}
      report.ok=true;write();clearTimeout(watchdog);app.quit();return;
    }
    if (['model-switch', 'model-switch-restore', 'model-switch-active'].includes(phase)) {
      await require('./background-model-check.cjs').runModelCheck({ phase, out, report, ev, getActiveCcbProcesses, verifyDefaultEntry, win });
      report.ok = true;
      if (!write()) throw new Error('model acceptance report is not writable');
      clearTimeout(watchdog);
      app.quit();
      return;
    }
    if (phase === 'git') {
      report.focusable = win.isFocusable();
      report.offscreen = win.webContents.isOffscreen();
      const workspace = process.env.CLAUDE_WORKSPACE;
      const fixture = JSON.parse(fs.readFileSync(path.join(out, 'git-fixture.json'), 'utf8'));
      assert.equal(path.resolve(workspace), path.resolve(fixture.workspace));
      const bridge = (method, args) => ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      report.modelCalled = false;
      report.trust = await bridge('saveTrust', [workspace, true]);
      assert.equal(report.trust.trusted, true);
      report.session = await bridge('start', [{ cwd: workspace, title: 'Hidden Git panel proof', permissionMode: 'ask' }]);
      assert.ok(report.session.sessionId);
      report.sessionId = report.session.sessionId;
      report.gitInfo = await bridge('getGitInfo', [workspace]);
      report.branches = await bridge('getLocalBranches', [workspace]);
      report.workingTree = await bridge('getWorkingTreeStatus', [workspace]);
      assert.equal(report.gitInfo.branch, fixture.branch);
      assert.ok(report.branches.includes(fixture.branch) && report.branches.includes('main'));
      assert.ok(report.workingTree.files.some(file => file.path === 'proof.txt'));
      report.bridge = {
        diff: await bridge('getGitDiff', [workspace, 'main']),
        stats: await bridge('getGitDiffStats', [workspace, 'main']),
        content: await bridge('getDiffFileContent', [workspace, fixture.baseSha, 'proof.txt']),
        patch: await bridge('getGitDiffFilePatch', [workspace, fixture.baseSha, 'proof.txt']),
        commits: await bridge('getGitCommits', [workspace, 'main']),
        commitDiff: await bridge('getCommitDiff', [workspace, fixture.headSha]),
      };
      assert.ok(report.bridge.diff.files.some(file => file.filename === 'proof.txt'));
      assert.ok(report.bridge.stats.fileCount >= 2);
      assert.ok(report.bridge.content.newText.includes(fixture.marker));
      assert.ok(report.bridge.patch.includes(fixture.marker));
      assert.ok(report.bridge.commits.some(commit => commit.sha === fixture.headSha));
      assert.ok(report.bridge.commitDiff.files.some(file => file.filename === 'proof-committed.txt'));
      await ev(`history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(report.sessionId)});dispatchEvent(new PopStateEvent('popstate'));true`);
      await sleep(2200);
      report.route = await ev('location.pathname');
      assert.equal(report.route, '/epitaxy/' + report.sessionId);
      // Native menu evidence: index.chunk-lzaSYO3Q.js @5185202 names Show Changes,
      // CmdOrCtrl+Shift+D, Rg.Diff. This enters the real renderer MenuEvents path.
      report.menu = appMenu.click('Show Changes');
      report.menuEvents = appMenu.sent.slice(-1);
      assert.equal(report.menu.ok, true);
      await sleep(2200);
      report.dismissedOnboarding = await ev("(()=>{const h=[...document.querySelectorAll('h1,h2,h3')].find(e=>/浏览全部|Browse all/.test(e.textContent));if(!h)return false;let p=h.parentElement;for(let i=0;p&&i<3;i++,p=p.parentElement){const b=p.querySelector('button[aria-label=\"关闭\"],button[aria-label=\"Close\"]');if(b){b.click();return true}}return false})()");
      await sleep(300);
      const dom = () => ev("(()=>{const shadowText=[];let shadowRoots=0;function visit(root){for(const e of root.querySelectorAll('*')){if(e.shadowRoot){shadowRoots++;visit(e.shadowRoot)}if(root instanceof ShadowRoot&&e.children.length===0&&!['STYLE','SCRIPT','TEMPLATE'].includes(e.tagName)){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0&&e.textContent.trim())shadowText.push(e.textContent)}}}visit(document);return {text:document.body.innerText,shadowText,shadowRoots,buttons:[...document.querySelectorAll('button')].map(e=>({text:e.textContent,label:e.getAttribute('aria-label'),testid:e.dataset.testid})),headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent)}})()");
      // Packaged chunks and Git work finish asynchronously. Wait for the actual
      // file row rather than treating an arbitrary initial delay as readiness.
      const gitReadyDeadline = Date.now() + 20000;
      report.beforeSelect = await dom();
      while (!report.beforeSelect.text.includes('proof.txt') && Date.now() < gitReadyDeadline) {
        await sleep(250);
        report.beforeSelect = await dom();
      }
      fs.writeFileSync(path.join(out, 'git-panel-open.png'), (await win.webContents.capturePage()).toPNG());
      const point = await ev("(()=>{const e=[...document.querySelectorAll('main *,[role=treeitem]')].filter(e=>e.textContent.trim()==='proof.txt').find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      report.filePoint = point;
      if (point && !report.beforeSelect.shadowText.join('\n').includes(fixture.marker)) {
        win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
        win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
        await sleep(1800);
      }
      report.dom = await dom();
      report.ui = {
        branch: report.dom.text.includes(fixture.branch),
        file: report.dom.text.includes('proof.txt'),
        diffContent: report.dom.text.includes(fixture.marker) || report.dom.shadowText.join('\n').includes(fixture.marker),
        noFatalError: !report.dom.text.includes('This page ran into a problem'),
      };
      fs.writeFileSync(path.join(out, 'git.png'), (await win.webContents.capturePage()).toPNG());
      assert.ok(report.ui.branch, 'actual branch is absent from rendered Git UI');
      assert.ok(report.ui.file, 'actual changed file is absent from rendered Git UI');
      assert.ok(report.ui.diffContent, 'actual diff content is absent from rendered Git UI');
      assert.ok(report.ui.noFatalError);
      report.ok = true;
      if (!write()) throw new Error('background Git report is not writable');
      clearTimeout(watchdog);
      app.quit();
      return;
    }
    if (phase === 'files') {
      const workspace=process.env.CLAUDE_WORKSPACE;
      const file=path.join(workspace,'round332-editor.md');
      const session=await ev(`window['claude.web'].LocalSessions.start(${JSON.stringify({cwd:workspace,title:'Background file editor proof'})})`);
      const sid=JSON.stringify(session.sessionId),fileExpr=JSON.stringify(file);
      const call=(method,args='')=>ev(`window['claude.web'].LocalSessions.${method}(${sid}${args?', '+args:''})`);
      report.sessionId=session.sessionId;
      report.created=await call('createSessionFile',fileExpr);
      assert.equal(report.created.status,'ok');
      report.initialWrite=await call('writeSessionFile',fileExpr+", 'ROUND332_INITIAL'");
      assert.equal(report.initialWrite.status,'ok');
      await ev(`history.pushState({}, '', '/epitaxy/'+${sid});dispatchEvent(new PopStateEvent('popstate'));true`);
      await sleep(1600);
      report.menu=appMenu.click('Show Files');
      assert.equal(report.menu.ok,true);
      await sleep(1600);
      const point=await ev("(()=>{const r=[...document.querySelectorAll('[data-files-tree] [role=treeitem]')].find(e=>e.textContent.includes('round332-editor.md'));if(!r)return null;const b=r.getBoundingClientRect();return {x:Math.round(b.x+Math.min(100,b.width/2)),y:Math.round(b.y+b.height/2)}})()");
      assert.ok(point,'file tree did not show the created file');
      win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
      win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
      await sleep(2000);
      const sourceToggle=await ev("(()=>{const b=[...document.querySelectorAll('button')].find(e=>['查看源代码','View source'].includes(e.getAttribute('aria-label')));if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      if(sourceToggle){win.webContents.sendInputEvent({type:'mouseDown',...sourceToggle,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...sourceToggle,button:'left',clickCount:1});await sleep(1600);}
      fs.writeFileSync(path.join(out,'files-open.png'),(await win.webContents.capturePage()).toPNG());
      report.filePane=await ev("({rows:[...document.querySelectorAll('[data-files-tree] [role=treeitem]')].map(e=>({text:e.textContent,label:e.getAttribute('aria-label')})),buttons:[...document.querySelectorAll('main button')].map(e=>({text:e.textContent,label:e.getAttribute('aria-label'),testid:e.dataset.testid})).slice(-20)})");
      report.editor=await ev("(()=>{const e=document.querySelector('.cm-content[contenteditable=true]');if(!e)return {found:false,editables:[...document.querySelectorAll('[contenteditable]')].map(x=>({class:x.className,text:x.textContent.slice(0,100)}))};e.focus();return {found:true,text:e.textContent,focused:document.activeElement===e}})()");
      assert.equal(report.editor.found,true,JSON.stringify(report.editor));
      assert.ok(report.editor.text.includes('ROUND332_INITIAL'));
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});
      await win.webContents.insertText('ROUND332_UI_SAVED');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'S',modifiers:['control']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'S',modifiers:['control']});
      await sleep(1800);
      report.savedContents=fs.readFileSync(file,'utf8');
      assert.equal(report.savedContents,'ROUND332_UI_SAVED');
      const read=await call('readSessionFile',fileExpr);
      report.browserHash=await ev(`crypto.subtle.digest('SHA-256',new TextEncoder().encode('ROUND332_UI_SAVED')).then(b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join(''))`);
      assert.equal(read.hash,report.browserHash);
      fs.writeFileSync(file,'ROUND332_EXTERNAL');
      report.conflict=await call('writeSessionFile',fileExpr+", 'SHOULD_NOT_SAVE', "+JSON.stringify(read.hash));
      assert.equal(report.conflict.status,'conflict');
      assert.equal(fs.readFileSync(file,'utf8'),'ROUND332_EXTERNAL');
      report.existingCreate=await call('createSessionFile',fileExpr);
      assert.equal(report.existingCreate.status,'conflict');
      fs.writeFileSync(path.join(out,'files.png'),(await win.webContents.capturePage()).toPNG());
      report.ok=true;write();clearTimeout(watchdog);app.quit();return;
    }
    if (phase === 'surfaces') {
      const routes = ['#settings/general', '#settings/data-privacy-controls', '#settings/usage', '#settings/claude-code', '#settings/import', '#settings/desktop', '#customize/skills/yours', '#customize/connectors/yours', '#customize/plugins/yours'];
      const labels = [['常规','General'], ['隐私','Privacy'], ['使用情况','Usage'], ['Claude Code'], ['导入和导出','Import and export'], ['系统','System'], ['Skills'], ['连接器','Connectors'], ['插件','Plugins']];
      report.surfaces = [];
      await ev("location.hash='#settings/general';true");
      await sleep(500);
      const nav = await ev("[...document.querySelectorAll('[role=dialog] a,[role=dialog] button,[role=dialog] [role=tab]')].map(e=>({tag:e.tagName,text:e.textContent,testid:e.dataset.testid,href:e.getAttribute('href'),role:e.getAttribute('role')}))");
      fs.writeFileSync(path.join(out, 'navigation.json'), JSON.stringify(nav, null, 2));
      for (const route of routes) {
        const point = await ev(`(()=>{const labels=${JSON.stringify(labels[routes.indexOf(route)])};const b=[...document.querySelectorAll('[role=dialog] button')].find(e=>labels.includes(e.textContent.replace(/[\\uE000-\\uF8FF]/g,'').trim()));if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
        assert.ok(point, 'missing settings navigation for ' + route);
        // Chromium input targets only this offscreen webContents, never the OS desktop.
        win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
        await sleep(1500);
        const surface = await ev("(()=>{const d=document.querySelector('[role=dialog]');return {hash:location.hash,dialog:!!d,text:d?.textContent||'',headings:d?[...d.querySelectorAll('h1,h2,h3')].map(e=>e.textContent):[]}})()");
        assert.equal(surface.hash, route);
        assert.ok(surface.dialog && surface.text.length > 20, 'missing settings surface ' + route);
        report.surfaces.push(surface);
        fs.writeFileSync(path.join(out, 'surface-' + report.surfaces.length + '.png'), (await win.webContents.capturePage()).toPNG());
      }
      assert.equal(new Set(report.surfaces.map(s=>s.text)).size, routes.length, 'routes must render distinct content');
      report.ok = true;
      write();
      clearTimeout(watchdog);
      app.quit();
      return;
    }
    if (phase === 'configuration') {
      await ev("location.hash = '#settings/claude-code'; true");
      await sleep(1200);
      report.configuration = await ev("({hash:location.hash,dialog:!!document.querySelector('[role=dialog]'),userMenu:!!document.querySelector('[data-testid=user-menu-button]')})");
      assert.ok(report.configuration.dialog, 'configuration must be available before inference is configured');
      fs.writeFileSync(path.join(out, phase + '.png'), (await win.webContents.capturePage()).toPNG());
      report.ok = true;
      write();
      clearTimeout(watchdog);
      app.quit();
      return;
    }
    // The message path, driven by a deterministic agent so it does not depend on the provider.
    //
    // set CLAUDE_AGENT_STUB_TEXT and desktop/main.cjs replaces only the model call; the kernel,
    // the transcript, the event stream and the renderer stay real. That is what this phase
    // exercises: send a message, read the reply, and confirm the transcript gained both rows.
    //
    // It exists because the provider returned 503 'no available accounts' for three consecutive
    // rounds, so the app's core action had no acceptance coverage at all. A stub is not a
    // substitute for the real model — it cannot catch a wrong request shape — but it does prove
    // the plumbing around the model works while the model itself is unreachable.
    if (phase === 'native-error') {
      const session = await ev(`window['claude.web'].LocalSessions.start(${JSON.stringify({cwd:process.env.CLAUDE_WORKSPACE})})`);
      report.sessionId = session.sessionId;
      await verifyDefaultEntry(session.sessionId);
      report.result = await ev(`window['claude.web'].LocalSessions.sendMessage(${JSON.stringify(session.sessionId)},'Default native controlled error proof')`);
      assert.ok(['error','exception'].includes(report.result.stopReason));
      assert.ok(JSON.stringify(report.result).includes('CONTROLLED_UPSTREAM_FAILURE'));
      const after = await ev(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(session.sessionId)})`);
      assert.equal(after.kernelBackend, 'ccb');
      report.backendAfterFailure = after.kernelBackend;
      report.realModelService = false;
      report.ok = true;
      if (!write()) throw new Error('Native failure acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'activation') {
      assert.ok(previewActivation);
      await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true");
      report.syntheticDomAccepted = previewActivation.consume(win.webContents);
      assert.equal(report.syntheticDomAccepted, false);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      await sleep(100);
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      report.nativeInputAccepted = previewActivation.consume(win.webContents);
      report.reusedInputAccepted = previewActivation.consume(win.webContents);
      assert.equal(report.nativeInputAccepted, true); assert.equal(report.reusedInputAccepted, false);
      report.realModelService = false;
      report.inputSentOnlyToHiddenFixture = true;
      report.ok = true;
      if (!write()) throw new Error('Activation acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }
    if (phase === 'browser') {
      const workspace = process.env.CLAUDE_WORKSPACE;
      const call = (service, method, args = []) => ev(`window['claude.web'][${JSON.stringify(service)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      await call('LocalSessions', 'saveTrust', [workspace, true]);
      const session = await call('LocalSessions', 'start', [{ cwd: workspace }]);
      report.sessionId = session.sessionId;
      const beforeIds = new Set(require('electron').webContents.getAllWebContents().map(contents => contents.id));
      report.previewId = await call('Launch', 'startBrowserPreview', [workspace, session.sessionId]);
      const enabled = process.env.CLAUDE_PROOF_BROWSER_FIXTURE === 'enabled';
      report.configuredFeature = enabled;
      if (enabled) {
        assert.equal(report.previewId, 'preview-' + session.sessionId);
        report.tabs = await call('Launch', 'getPreviewTabs', [report.previewId]);
        assert.equal(report.tabs.tabs.length, 1);
        report.activeServers = await ev("window['claude.web'].Launch.activeServersStore.getState()");
        assert.ok(report.activeServers.some(row => row.previewId === report.previewId && row.sessionId === session.sessionId));
      } else assert.equal(report.previewId, null);
      report.unverifiedRemote = await call('Launch', 'ensureRemoteBlankPreview', ['session_unverified360', false]);
      assert.equal(report.unverifiedRemote, null);
      report.forgedRemoteRemember = await call('Launch', 'recordRemotePaneOriginDecision', ['session_unverified360', 'https://never-requested.invalid', true, {userGesture:true}]);
      assert.equal(report.forgedRemoteRemember, false);
      const created = require('electron').webContents.getAllWebContents().filter(contents => !beforeIds.has(contents.id));
      await call('LocalSessions', 'delete', [session.sessionId]);
      const until = Date.now() + 3000;
      while (created.some(contents => !contents.isDestroyed()) && Date.now() < until) await sleep(50);
      report.deletedContentsDestroyed = created.every(contents => contents.isDestroyed());
      assert.equal(report.deletedContentsDestroyed, true);
      report.realModelService = false;
      report.remoteIdentityNotFabricated = true;
      report.ok = true;
      if (!write()) throw new Error('Browser acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'artifact') {
      const workspace = process.env.CLAUDE_WORKSPACE;
      const call = (service, method, args = []) => ev(`window['claude.web'][${JSON.stringify(service)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      const started = await call('LocalSessions', 'start', [{ cwd: workspace }]);
      report.sessionId = started.sessionId;
      const pages = require('electron').webContents;
      const findPage = async title => {
        const until = Date.now() + 10000;
        do {
          for (const contents of pages.getAllWebContents()) {
            if (contents === win.webContents || contents.isDestroyed() || !/^(?:claude-preview:|data:)/.test(contents.getURL())) continue;
            try { if (await contents.executeJavaScript('document.title') === title) return contents; } catch {}
          }
          await sleep(100);
        } while (Date.now() < until);
        throw new Error('Owned artifact page did not load: ' + title);
      };
      const contentId = await call('Launch', 'loadHtmlPreviewContent', ['<html><head><title>STATIC_CSP_360</title></head><body>STATIC_CSP_360<script>window.STATIC_RAN_360=true</script></body></html>', path.join(workspace,'virtual.html'), false, workspace, started.sessionId]);
      assert.equal(typeof contentId, 'string');
      const staticPage = await findPage('STATIC_CSP_360');
      report.content = { id: contentId, scriptBlocked: await staticPage.executeJavaScript('window.STATIC_RAN_360 !== true') };
      assert.equal(report.content.scriptBlocked, true);
      const outside = path.join(out, 'outside-artifact.html');
      fs.writeFileSync(outside, '<html><title>OUTSIDE_MUST_NOT_LOAD_360</title></html>');
      report.outsideFileUrl = await call('Launch', 'loadHtmlPreview', [require('node:url').pathToFileURL(outside).href, started.sessionId, workspace]);
      assert.equal(report.outsideFileUrl, null);
      const file = path.join(workspace, 'artifact-proof.html');
      fs.writeFileSync(file, '<html><head><title>FILE_NATIVE_360</title></head><body><button id="increment" onclick="document.body.dataset.count=String(Number(document.body.dataset.count)+1)">Increment</button><script>window.FILE_RAN_360=7;document.body.dataset.count="0"</script></body></html>');
      const fileId = await call('Launch', 'loadHtmlPreview', [file, started.sessionId, workspace]);
      assert.equal(typeof fileId, 'string');
      const filePage = await findPage('FILE_NATIVE_360');
      report.file = { id: fileId, protocol: new URL(filePage.getURL()).protocol, inlineValue: await filePage.executeJavaScript('window.FILE_RAN_360') };
      assert.equal(report.file.inlineValue, 7);
      report.file.clickedCount = await filePage.executeJavaScript("document.getElementById('increment').click();document.body.dataset.count");
      assert.equal(report.file.clickedCount, '1');
      const captureArtifact = async (id, filename) => {
        assert.equal(await call('Launch', 'showPreview', [id, {x:950,y:80,width:900,height:800}]), true);
        await sleep(300);
        const encoded = await call('Launch', 'capturePreviewScreenshot', [id]);
        assert.equal(typeof encoded, 'string');
        const bytes = Buffer.from(encoded, 'base64');
        const image = require('electron').nativeImage.createFromBuffer(bytes);
        assert.equal(image.isEmpty(), false, 'artifact capture must decode as an actual image');
        fs.writeFileSync(path.join(out, filename), bytes);
        return image.getSize();
      };
      report.file.capture = await captureArtifact(fileId, 'artifact-file.png');

      const interactive = process.env.CLAUDE_PROOF_BROWSER_FIXTURE === 'enabled';
      report.configuredInteractive = interactive;
      assert.equal(fileId === 'preview-' + started.sessionId, interactive);
      if (interactive) {
        fs.writeFileSync(path.join(workspace, 'relative.css'), 'body{background-color:rgb(9, 34, 56);color:white;font:30px sans-serif}');
        fs.writeFileSync(path.join(workspace, 'relative.js'), 'window.RELATIVE_360="relative-js"');
        fs.writeFileSync(path.join(workspace, 'relative.html'), '<html><head><title>RELATIVE_360</title><link rel="stylesheet" href="relative.css"></head><body>RELATIVE_360<script src="relative.js"></script></body></html>');
        const relativeId = await call('Launch', 'loadHtmlPreview', [path.join(workspace,'relative.html'), started.sessionId, workspace]);
        assert.equal(relativeId, fileId);
        const relativePage = await findPage('RELATIVE_360');
        report.relative = await relativePage.executeJavaScript('({script:window.RELATIVE_360,background:getComputedStyle(document.body).backgroundColor})');
        assert.equal(report.relative.script, 'relative-js');
        assert.equal(report.relative.background, 'rgb(9, 34, 56)');
        report.relative.capture = await captureArtifact(relativeId, 'artifact-relative.png');
      }
      await call('LocalSessions', 'delete', [started.sessionId]);
      const until = Date.now() + 3000;
      while (!filePage.isDestroyed() && Date.now() < until) await sleep(50);
      report.deletedPageDestroyed = filePage.isDestroyed();
      assert.equal(report.deletedPageDestroyed, true);
      report.realModelService = false;
      report.ok = true;
      if (!write()) throw new Error('Artifact acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'governor' || phase === 'governor-ccb') {
      assert.ok(cliGovernor);
      report.level = cliGovernor.sampleNow();
      report.diagnostics = cliGovernor.diagnostics();
      report.cap = cliGovernor.currentCap();
      assert.equal(report.diagnostics.memorySourceState, 'sampled');
      assert.ok(Number.isFinite(report.diagnostics.lastRatio));
      assert.equal(report.cap, Math.max(6, Math.floor(require('node:os').totalmem() / (3 * 1024 ** 3))));
      if (phase === 'governor-ccb') {
        const started = await ev(`window['claude.web'].LocalSessions.start(${JSON.stringify({cwd:process.env.CLAUDE_WORKSPACE})})`);
        report.sessionId = started.sessionId;
        const until = Date.now() + 25000;
        do {
          report.processes = getActiveCcbProcesses();
          if (report.processes.some(process => process.sessionId === started.sessionId && process.initialized)) break;
          await sleep(100);
        } while (Date.now() < until);
        assert.ok(report.processes.some(process => process.sessionId === started.sessionId && process.initialized && process.pid > 0));
        assert.equal(cliGovernor.effective(), report.processes.length);
      }
      report.effective = cliGovernor.effective();
      report.realModelService = false;
      report.modelRequestSent = false;
      report.ok = true;
      if (!write()) throw new Error('Governor acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'landing') {
      const workspace = process.env.CLAUDE_WORKSPACE;
      const nested = path.join(workspace, 'landing-dir', 'child');
      const outside = path.join(out, 'landing-outside');
      fs.mkdirSync(nested, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(nested, 'inside.txt'), 'inside fixture');
      fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside fixture');
      const internalLink = path.join(workspace, 'landing-internal'), externalLink = path.join(workspace, 'landing-external');
      fs.symlinkSync(nested, internalLink, 'junction'); fs.symlinkSync(outside, externalLink, 'junction');
      const call = (method, args = []) => ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      await call('saveTrust', [workspace, true]);
      report.nested = await call('listDirectoryAtCwd', [nested, nested]);
      assert.ok(report.nested.some(row => row.name === 'inside.txt'));
      report.internal = await call('listDirectoryAtCwd', [workspace, internalLink]);
      assert.ok(report.internal.some(row => row.name === 'inside.txt'));
      report.external = await call('listDirectoryAtCwd', [workspace, externalLink]);
      assert.deepEqual(report.external, []);
      report.runtimeMetadata = { isLink: fs.lstatSync(internalLink).isSymbolicLink() };
      try { fs.readlinkSync(internalLink); report.runtimeMetadata.readlinkWorks = true; }
      catch (error) { report.runtimeMetadata.readlinkError = error.code; }
      report.realModelService = false;
      report.ok = true;
      if (!write()) throw new Error('Landing acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'av') {
      const workspace = process.env.CLAUDE_WORKSPACE;
      const dataBytes = 1600, wav = Buffer.alloc(44 + dataBytes);
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
      const audioFile = path.join(workspace, 'proof.wav'), videoFile = path.join(workspace, 'proof.webm');
      fs.writeFileSync(audioFile, wav);
      const webm = fs.readFileSync(path.join(__dirname, '..', 'resources', 'ion-dist', 'images', 'install-hub', 'clawd-laptop.webm'));
      fs.writeFileSync(videoFile, webm);
      const call = (method, args = []) => ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      const session = await call('start', [{ cwd: workspace }]);
      report.sessionId = session.sessionId;
      const audioUrl = await call('getSessionMediaStreamUrl', [session.sessionId, audioFile]);
      const videoUrl = await call('getSessionPanelMediaStreamUrl', [session.sessionId, videoFile]);
      assert.equal(new URL(audioUrl).hostname, 'v'); assert.equal(new URL(videoUrl).hostname, 'v');
      report.decoded = await ev(`Promise.all([['audio',${JSON.stringify(audioUrl)}],['video',${JSON.stringify(videoUrl)}]].map(([kind,url])=>new Promise((resolve,reject)=>{const media=document.createElement(kind);media.preload='auto';media.muted=true;media.volume=0;media.controls=true;media.style.cssText='position:fixed;left:400px;top:'+(kind==='audio'?100:180)+'px;width:320px;height:'+(kind==='audio'?40:200)+'px;z-index:10000';media.onloadeddata=()=>resolve({kind,duration:media.duration,readyState:media.readyState,width:media.videoWidth||0,height:media.videoHeight||0});media.onerror=()=>reject(Error(kind+' decode failed'));document.body.appendChild(media);media.src=url;media.load();})))`);
      assert.ok(report.decoded.find(item => item.kind === 'audio').readyState >= 2);
      assert.ok(report.decoded.find(item => item.kind === 'video').width > 0);
      const net = require('electron').net;
      report.ranges = [];
      for (const [url, expected] of [[audioUrl, wav], [videoUrl, webm]]) {
        const response = await net.fetch(url, { headers: { Range: 'bytes=0-7' } });
        const bytes = Buffer.from(await response.arrayBuffer());
        report.ranges.push({ status: response.status, bytesMatch: bytes.equals(expected.subarray(0, 8)), contentType: response.headers.get('content-type') });
        assert.equal(response.status, 206); assert.equal(bytes.equals(expected.subarray(0, 8)), true);
      }
      fs.writeFileSync(path.join(out, 'av.png'), (await win.webContents.capturePage()).toPNG());
      await call('delete', [session.sessionId]);
      report.deletedStatuses = [(await net.fetch(audioUrl)).status, (await net.fetch(videoUrl)).status];
      assert.deepEqual(report.deletedStatuses, [404, 404]);
      report.realModelService = false; report.fixtureMediaInsertedByHarness = true; report.audioPlayed = false;
      report.ok = true;
      if (!write()) throw new Error('AV acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'media') {
      const workspace = process.env.CLAUDE_WORKSPACE;
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
      const bytes = Buffer.alloc(1024 * 1024); png.copy(bytes);
      const file = path.join(workspace, 'large-proof.png');
      fs.writeFileSync(file, bytes);
      const call = (method, args = []) => ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      const started = await call('start', [{ cwd: workspace }]);
      const url = await call('getSessionImageStreamUrl', [started.sessionId, file]);
      assert.ok(url && url.startsWith('claude-media://s/'));
      report.sessionId = started.sessionId;
      report.decoded = await ev(`new Promise((resolve,reject)=>{const image=document.createElement('img');image.dataset.testid='stream-media-proof';image.style.cssText='width:128px;height:128px;image-rendering:pixelated;border:2px solid green';image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(Error('Native media image failed to decode'));document.body.appendChild(image);image.src=${JSON.stringify(url)};})`);
      assert.equal(report.decoded.width, 1); assert.equal(report.decoded.height, 1);
      const net = require('electron').net;
      const response = await net.fetch(url, { headers: { Range: 'bytes=0-7' } });
      const actual = Buffer.from(await response.arrayBuffer());
      report.range = { status: response.status, contentRange: response.headers.get('content-range'), byteLength: actual.length, pngHeader: actual.equals(bytes.subarray(0, 8)) };
      assert.equal(response.status, 206); assert.equal(report.range.pngHeader, true);
      fs.writeFileSync(path.join(out, 'media.png'), (await win.webContents.capturePage()).toPNG());
      await call('delete', [started.sessionId]);
      report.deletedUrlStatus = (await net.fetch(url)).status;
      assert.equal(report.deletedUrlStatus, 404);
      report.realModelService = false;
      report.fixtureImageInsertedByHarness = true;
      report.ok = true;
      if (!write()) throw new Error('Media acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'scheduler') {
      const workspace = process.env.CLAUDE_WORKSPACE;
      const call = (service, method, args = []) => ev(`window['claude.web'][${JSON.stringify(service)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      await call('LocalSessions', 'saveTrust', [workspace, true]);
      await ev("window.__taskEvents=[];window.__taskOff=window['claude.web'].CCDScheduledTasks.onOnScheduledTaskEvent(event=>window.__taskEvents.push(event));true");
      const task = await call('CCDScheduledTasks', 'createScheduledTask', [{ name: 'hidden-scheduled-proof', description: 'Hidden renderer dispatch proof', prompt: 'Reply with SCHEDULED_ACCEPTANCE_OK', cwd: workspace, fireAt: Date.now() + 1500 }]);
      report.taskId = task.id;
      const until = Date.now() + 18000;
      let session = null;
      while (Date.now() < until) {
        const sessions = await call('LocalSessions', 'getAll');
        session = sessions.find(candidate => candidate.scheduledTaskId === task.id);
        if (session && !session.isRunning) break;
        await sleep(250);
      }
      report.events = await ev('window.__taskEvents');
      report.tasks = await call('CCDScheduledTasks', 'getAllScheduledTasks');
      assert.ok(session, 'shipped renderer did not start the dispatched task');
      report.sessionId = session.sessionId;
      report.transcript = await call('LocalSessions', 'getTranscript', [session.sessionId]);
      assert.ok(report.transcript.some(row => row.type === 'assistant' && JSON.stringify(row.message).includes('SCHEDULED_ACCEPTANCE_OK')));
      assert.equal(report.tasks.find(candidate => candidate.id === task.id).enabled, false);
      report.realModelService = false;
      report.modelUsesStub = true;
      await call('CCDScheduledTasks', 'updateScheduledTaskStatus', [task.id, 'deleted', true]);
      await ev('window.__taskOff();true');
      report.ok = true;
      if (!write()) throw new Error('Scheduler acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'preview') {
      const workspace = process.env.CLAUDE_WORKSPACE;
      const runtimeRoot = require('./ccb-runtime-paths.cjs').resolveAgentRoot();
      const bun = path.join(runtimeRoot, 'agent-core', 'bun', 'bun.exe');
      const fixture = path.join(workspace, 'preview-fixture.cjs');
      fs.writeFileSync(fixture, "const server=require('node:http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<html><head><title>PREVIEW_REAL_PAGE</title></head><body style=\"background:#e9f5ef;font:28px sans-serif\"><h1>PREVIEW_REAL_PAGE</h1><a href=\"/second\">Second page</a></body></html>')});server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));");
      fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.claude', 'launch.json'), JSON.stringify({ configurations: [{ name: 'proof', runtimeExecutable: bun, runtimeArgs: [fixture] }] }));
      const call = (service, method, args = []) => ev(`window['claude.web'][${JSON.stringify(service)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      await call('LocalSessions', 'saveTrust', [workspace, true]);
      const started = await call('LocalSessions', 'start', [{ cwd: workspace }]);
      await ev(`history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(started.sessionId)});dispatchEvent(new PopStateEvent('popstate'));true`);
      await sleep(1200);
      await ev("window.__previewEvents=[];window.__previewOff=window['claude.web'].Launch.onPreviewTabsChanged((...args)=>window.__previewEvents.push(args));true");
      const launch = await call('Launch', 'startFromConfig', [workspace, 'proof', started.sessionId]);
      report.launch = launch;
      assert.ok(launch.serverId);
      try {
        assert.ok(launch.previewId && launch.tabId, 'actual browser page did not load');
        report.tabs = await call('Launch', 'getPreviewTabs', [launch.previewId]);
        assert.ok(report.tabs.tabs.some(tab => tab.title === 'PREVIEW_REAL_PAGE'));
        report.store = await ev("window['claude.web'].Launch.activeServersStore.getState()");
        assert.ok(report.store.some(server => server.serverId === launch.serverId && server.status === 'running'));
        const previewUrl = await call('Launch', 'getPreviewUrl', [launch.previewId]);
        const presentation = () => (win.contentView.children || []).filter(view => view.webContents && !view.webContents.isDestroyed())
          .map(view => ({ url: view.webContents.getURL(), bounds: view.getBounds() }));
        const waitForPresentation = async expected => {
          const until = Date.now() + 15000;
          do {
            const views = presentation();
            const attached = views.some(view => view.url === previewUrl && view.bounds.width > 0 && view.bounds.height > 0);
            if (attached === expected) return views;
            await sleep(100);
          } while (Date.now() < until);
          throw new Error('Actual Preview presentation did not become ' + (expected ? 'visible' : 'hidden'));
        };
        // activeServers automatically opens and binds the pane. A menu click is
        // a toggle: clicking first would close a successfully mounted preview.
        report.autoPresentation = await waitForPresentation(true);
        fs.writeFileSync(path.join(out, 'preview-auto.png'), (await win.webContents.capturePage()).toPNG());
        report.hideMenu = appMenu.click('Show Preview');
        assert.equal(report.hideMenu.ok, true);
        report.hiddenPresentation = await waitForPresentation(false);
        report.reopenMenu = appMenu.click('Show Preview');
        assert.equal(report.reopenMenu.ok, true);
        report.reopenedPresentation = await waitForPresentation(true);
        const image = await call('Launch', 'capturePreviewScreenshot', [launch.previewId]);
        assert.equal(typeof image, 'string');
        const bytes = Buffer.from(image, 'base64');
        const decoded = require('electron').nativeImage.createFromBuffer(bytes);
        report.capture = decoded.getSize();
        assert.ok(report.capture.width > 0 && report.capture.height > 0);
        fs.writeFileSync(path.join(out, 'preview-page.png'), bytes);
        report.events = await ev('window.__previewEvents');
        assert.ok(report.events.some(args => args[0] === launch.previewId && Array.isArray(args[1])));
        report.dom = await ev("document.body.innerText.slice(-1600)");
        fs.writeFileSync(path.join(out, 'preview.png'), (await win.webContents.capturePage()).toPNG());
        report.realModelService = false;
      } finally {
        await call('Launch', 'stopServer', [launch.serverId]);
        await ev('window.__previewOff();true');
      }
      report.ok = true;
      if (!write()) throw new Error('Preview acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'images') {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=';
      const images = [{ base64: png, mimeType: 'image/png', filename: 'proof.png' }];
      const workspace = process.env.CLAUDE_WORKSPACE;
      const file = path.join(workspace, 'proof.png');
      fs.writeFileSync(file, Buffer.from(png, 'base64'));
      const bridge = (method, args) => ev(`window['claude.web'].LocalSessions[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
      const started = await bridge('start', [{ cwd: workspace }]);
      report.sessionId = started.sessionId;
      report.read = await bridge('readSessionImageAsDataUrl', [started.sessionId, file]);
      assert.equal(report.read, 'data:image/png;base64,' + png);
      await ev(`history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(started.sessionId)});dispatchEvent(new PopStateEvent('popstate'));true`);
      await sleep(1200);
      const uuid = require('node:crypto').randomUUID();
      report.send = await bridge('sendMessage', [started.sessionId, 'IMAGE_UI_PROOF', images, undefined, undefined, undefined, undefined, uuid]);
      assert.equal(report.send.ok, true);
      report.transcript = await bridge('getTranscript', [started.sessionId]);
      const user = report.transcript.find(row => row.type === 'user');
      report.requestedMessageUuid = uuid;
      report.storedMessageUuid = user.uuid;
      assert.equal(user.uuid, uuid);
      assert.equal(user.message.content.find(block => block.type === 'image').source.data, png);
      const until = Date.now() + 15000;
      const rendered = () => ev("[...document.querySelectorAll('main img')].map(i=>({src:i.currentSrc||i.src,complete:i.complete,width:i.naturalWidth,height:i.naturalHeight}))");
      report.images = await rendered();
      while (!report.images.some(i => i.src.startsWith('data:image/png') && i.complete && i.width > 0) && Date.now() < until) {
        await sleep(250); report.images = await rendered();
      }
      assert.ok(report.images.some(i => i.src.startsWith('data:image/png') && i.complete && i.width > 0), 'actual transcript image did not decode in the renderer');
      report.realModelService = false;
      fs.writeFileSync(path.join(out, 'images.png'), (await win.webContents.capturePage()).toPNG());
      report.ok = true;
      if (!write()) throw new Error('Image acceptance report is not writable');
      clearTimeout(watchdog); app.quit(); return;
    }

    if (phase === 'message') {
      const expected = process.env.CLAUDE_AGENT_STUB_TEXT || 'MESSAGE-PHASE-OK';
      const started = await ev(`window['claude.web'].LocalSessions.start(${JSON.stringify({ cwd: process.env.CLAUDE_WORKSPACE })})`);
      report.sessionId = started.sessionId;
      await ev(`history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(started.sessionId)});dispatchEvent(new PopStateEvent('popstate'));true`);
      await sleep(1200);
      const result = await ev(`window['claude.web'].LocalSessions.sendMessage(${JSON.stringify(started.sessionId)}, 'Reply with exactly: ' + ${JSON.stringify(expected)})`);
      report.send = { ok: result && result.ok, text: result && result.text, error: (result && result.error) || null };
      assert.equal(report.send.ok, true, 'sendMessage failed: ' + JSON.stringify(report.send));
      assert.equal(report.send.text, expected, 'the reply was ' + JSON.stringify(report.send.text));
      const transcript = await ev(`window['claude.web'].LocalSessions.getTranscript(${JSON.stringify(started.sessionId)})`);
      report.transcriptRows = transcript.length;
      report.transcriptTypes = transcript.map((r) => r.type);
      assert.equal(report.transcriptRows, 2, 'the transcript has ' + report.transcriptRows + ' rows');
      assert.deepEqual(report.transcriptTypes, ['user', 'assistant']);
      const assistantText = JSON.stringify(transcript[transcript.length - 1]);
      assert.ok(assistantText.includes(expected), 'the assistant row does not carry the reply');
      // And the renderer must show it, not just the store.
      await sleep(1500);
      report.rendered = await ev("(()=>{const m=document.querySelector('main');return m?(m.innerText||'').slice(0,400):null})()");
      assert.ok(report.rendered && report.rendered.includes(expected), 'the reply is not on screen: ' + JSON.stringify(report.rendered && report.rendered.slice(0, 120)));
      fs.writeFileSync(path.join(out, 'message.png'), (await win.webContents.capturePage()).toPNG());
      report.ok = true;
      write();
      clearTimeout(watchdog);
      app.quit();
      return;
    }

    // Opening a session that ALREADY exists is the one acceptance no phase covered: seed and
    // restore both create their own session, so the 'my history survived a restart' path — the
    // first thing a returning user cares about — had no evidence at all.
    //
    // This phase needs no model: it only reads the store and renders it.
    if (phase === 'history') {
      const all = await ev("window['claude.web'].LocalSessions.getAll()");
      assert.ok(Array.isArray(all), 'getAll did not answer an array');
      report.sessionCount = all.length;
      assert.ok(all.length > 0, 'the store has no sessions to open');
      // Pick the largest transcript: a big one exercises far more of the renderer than a seed.
      let best = null;
      for (const s of all) {
        const rows = await ev(`window['claude.web'].LocalSessions.getTranscript(${JSON.stringify(s.sessionId)}).then(r => (r || []).length)`);
        if (!best || rows > best.rows) best = { id: s.sessionId, rows };
      }
      report.opened = best;
      assert.ok(best.rows >= 2, 'no session with a real transcript was found');
      await ev(`history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(best.id)});dispatchEvent(new PopStateEvent('popstate'));true`);
      await sleep(2500);
      report.rendered = await ev("(()=>{const main=document.querySelector('main');if(!main)return null;const text=main.innerText||'';return {length:text.length,head:text.slice(0,200),messages:main.querySelectorAll('[data-testid=\"message\"],[class*=message]').length}})()");
      assert.ok(report.rendered, 'the session view did not render a <main>');
      assert.ok(report.rendered.length > 50, 'the opened session rendered almost nothing: ' + JSON.stringify(report.rendered));
      fs.writeFileSync(path.join(out, 'history.png'), (await win.webContents.capturePage()).toPNG());

      // Every EDGE SHAPE in the real store must also open without breaking the view.
      //
      // MEASURED on the live store: 198 sessions, of which 38 have no cwd, 31 have an empty
      // transcript, 3 are archived, and 3 reference a model that does not exist (left behind by
      // an earlier probe). Those are real rows a returning user can click, so 'the largest
      // session renders' is not enough — each shape must render too.
      const shapes = {
        emptyTranscript: all.find((s) => s && s.sessionId && !s.cwd) || null,
        archived: all.find((s) => s && s.isArchived) || null,
        unknownModel: all.find((s) => s && typeof s.model === 'string' && s.model.includes('not-a-real')) || null,
      };
      report.edgeShapes = {};
      for (const [label, candidate] of Object.entries(shapes)) {
        if (!candidate) { report.edgeShapes[label] = { present: false }; continue; }
        const before = await ev("(()=>{const m=document.querySelector('main');return m?(m.innerText||'').length:0})()");
        await ev(`history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(candidate.sessionId)});dispatchEvent(new PopStateEvent('popstate'));true`);
        await sleep(1800);
        const state = await ev("(()=>{const m=document.querySelector('main');return {hasMain:Boolean(m),length:m?(m.innerText||'').length:0,errorText:(document.body.innerText||'').match(/ran into a problem|Something went wrong|Unhandled/i)?.[0]||null}})()");
        report.edgeShapes[label] = { present: true, id: candidate.sessionId, rows: await ev(`window['claude.web'].LocalSessions.getTranscript(${JSON.stringify(candidate.sessionId)}).then(r => (r || []).length)`), ...state, previousLength: before };
        // Opening a session must not fall into the error boundary. A short or empty pane is fine;
        // a rendered error page is not.
        assert.equal(state.errorText, null, label + ' opened into an error boundary: ' + JSON.stringify(state));
        assert.equal(state.hasMain, true, label + ' left no <main> in the DOM');
      }
      fs.writeFileSync(path.join(out, 'history-edge.png'), (await win.webContents.capturePage()).toPNG());

      // SWEEP: open EVERY session in the store, not just the sampled shapes.
      //
      // The shape probe above finds the categories I thought of. The sweep finds the ones I did
      // not: it is the difference between 'the largest session works' (round 342) and '22% of
      // sessions were unopenable' (round 343), which the largest-session check missed entirely
      // because it happened to pick a healthy row.
      //
      // Each visit is cheap (navigate + settle) but there are 200+ of them, so the settle time is
      // short and the watchdog is extended for this phase only.
      report.sweep = { visited: 0, failures: [] };
      const sweepLimit = Number(process.env.CLAUDE_SWEEP_LIMIT || 0) || all.length;
      for (const candidate of all.slice(0, sweepLimit)) {
        if (!candidate || !candidate.sessionId) continue;
        await ev(`history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(candidate.sessionId)});dispatchEvent(new PopStateEvent('popstate'));true`);
        await sleep(220);
        const probe = await ev("(()=>{const m=document.querySelector('main');return {hasMain:Boolean(m),error:(document.body.innerText||'').match(/ran into a problem|Something went wrong/i)?.[0]||null}})()");
        report.sweep.visited += 1;
        if (probe.error || !probe.hasMain) {
          report.sweep.failures.push({ id: candidate.sessionId, rows: null, hasMain: probe.hasMain, error: probe.error, cwd: candidate.cwd, model: candidate.model, archived: Boolean(candidate.isArchived), title: candidate.title });
          if (report.sweep.failures.length >= 10) break;
        }
      }
      assert.deepEqual(report.sweep.failures, [],
        report.sweep.failures.length + ' of ' + report.sweep.visited + ' sessions failed to open: ' + JSON.stringify(report.sweep.failures.slice(0, 3)));
      report.ok = true;
      write();
      clearTimeout(watchdog);
      app.quit();
      return;
    }
    let sid;
    if (phase === 'seed') {
      const s = await ev(`window['claude.web'].LocalSessions.start(${JSON.stringify({ cwd: process.env.CLAUDE_WORKSPACE, title: 'Packaged background acceptance', permissionMode: 'ask' })})`);
      sid = s.sessionId;
    } else sid = JSON.parse(fs.readFileSync(path.join(out, 'seed.json'), 'utf8')).sessionId;
    report.sessionId = sid;
    await ev(`history.pushState({}, '', '/epitaxy/' + ${JSON.stringify(sid)});dispatchEvent(new PopStateEvent('popstate'));true`);
    await sleep(1000);
    await verifyDefaultEntry(sid);
    const before = await ev(`window['claude.web'].LocalSessions.getTranscript(${JSON.stringify(sid)})`);
    const digestTranscript = rows => require('node:crypto').createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    if (phase === 'restore') {
      const seed = JSON.parse(fs.readFileSync(path.join(out, 'seed.json'), 'utf8'));
      if (seed.transcriptHash) assert.equal(digestTranscript(before), seed.transcriptHash);
      else assert.deepEqual(before, seed.transcript);
    }
    const prompt = phase === 'seed' ? 'Reply with exactly: ' + marker : 'Recall the exact token in your previous reply. Reply only with that token; use no tools.';
    const result = await ev(`window['claude.web'].LocalSessions.sendMessage(${JSON.stringify(sid)},${JSON.stringify(prompt)})`);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.text.trim(), marker);
    if (process.env.CLAUDE_PROOF_DEFAULT_ENTRY === '1') report.defaultEntry.childPid = getActiveCcbProcesses().find(child => child.sessionId === sid)?.pid || null;
    const transcript = await ev(`window['claude.web'].LocalSessions.getTranscript(${JSON.stringify(sid)})`);
    report.transcriptHash = digestTranscript(transcript);
    report.transcriptRows = transcript.length;
    report.transcriptTypes = transcript.map(row => row.type);
    report.fullTranscriptOmitted = true;
    assert.equal(report.transcriptRows, phase === 'seed' ? 2 : 4);
    await sleep(1000);
    report.renderedReplies = await ev(`([...document.querySelectorAll('main *')].filter(e=>e.textContent.trim()===${JSON.stringify(marker)}&&![...e.children].some(c=>c.textContent.trim()===${JSON.stringify(marker)}))).length`);
    assert.ok(report.renderedReplies >= 1);
    fs.writeFileSync(path.join(out, phase + '.png'), (await win.webContents.capturePage()).toPNG());
    report.ok = true;
    if (!write()) throw new Error('background acceptance report is not writable');
    clearTimeout(watchdog);
    app.quit();
  } catch (e) {
    report.ok = false;
    report.error = e.stack;
    write();
    clearTimeout(watchdog);
    app.exit(1);
  }
}
module.exports = { runBackgroundCheck };
