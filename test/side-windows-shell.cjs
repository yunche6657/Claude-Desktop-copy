// Side windows and global accelerators (Find in page, Quick Entry, About Claude,
// Sidebar collapse), verified in a live Electron window against the exact
// specifications recovered from ccd-ref/asar.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.env.ELECTRON_RUN_AS_NODE === '1') delete process.env.ELECTRON_RUN_AS_NODE;

let server;
let bus;
let detach;
let dir;

app.whenReady().then(async () => {
  const { createApp } = await import('../server.mjs');
  const { EipcBus } = require('../desktop/eipc-bus.cjs');
  const { registerDesktopServices } = require('../desktop/main-services.cjs');

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-win-'));
  server = createApp({ dataDir: path.join(dir, 'data'), mode: 'demo' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const win = new BrowserWindow({
    show: false,
    width: 1936,
    height: 1048,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/preload-main-view.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  bus = new EipcBus();
  detach = registerDesktopServices({ bus, mainWindow: win, sessions: server.sessions, mode: 'demo', consent: null });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);

  const js = code => win.webContents.executeJavaScript(code);
  await js('new Promise(r => setTimeout(r, 900))');

  // 1. Find in page bar (320x48, CJK or >2 chars threshold, step forward/back, Escape closes)
  const findResult = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    await wait(150);
    const bar = document.getElementById('find-bar');
    const input = document.getElementById('find-input');
    const status = document.getElementById('find-status');
    const rect = bar.getBoundingClientRect();

    // 2 ASCII chars -> not searchable yet
    input.value = 'in';
    input.dispatchEvent(new Event('input'));
    await wait(50);
    const twoCharStatus = status.textContent;

    // >2 ASCII chars -> searchable ('inbox' appears on welcome screen)
    input.value = 'inbox';
    input.dispatchEvent(new Event('input'));
    await wait(50);
    const matchStatus = status.textContent;

    // 1 CJK char -> immediately searchable ('新' appears in welcome/nav)
    input.value = '任务';
    input.dispatchEvent(new Event('input'));
    await wait(50);
    const cjkStatus = status.textContent;

    // Escape closes
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(50);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      twoCharStatus,
      matchStatus,
      cjkStatus,
      closedAfterEsc: bar.hidden,
    };
  })()`);

  assert.equal(findResult.width, 320, 'Find in page bar must be 320px wide');
  assert.equal(findResult.height, 48, 'Find in page bar must be 48px tall (comfortable density)');
  assert.equal(findResult.twoCharStatus, '', '2 ASCII chars must not trigger search');
  assert.match(findResult.matchStatus, /^1\/\d+$/, '3+ ASCII chars must report activeIndex/total');
  assert.equal(findResult.closedAfterEsc, true, 'Escape must close Find in page bar');

  // 2. About Claude modal (320x428, Version 2.42304.0 (e7f60e), click copies and shows Copied message)
  const aboutResult = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('about-toggle').click();
    await wait(150);
    const dlg = document.getElementById('about-dialog');
    const shell = dlg.querySelector('.about-shell');
    const rect = shell.getBoundingClientRect();
    const btn = document.getElementById('about-version-btn');
    const beforeText = btn.textContent;
    btn.click();
    await wait(80);
    const copiedText = btn.textContent;
    const titleText = dlg.querySelector('.about-title').textContent.replace(/\\s+/g, ' ').trim();
    const timeAttr = document.getElementById('about-time').getAttribute('datetime');
    document.getElementById('about-close').click();
    await wait(80);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      titleText,
      beforeText,
      copiedText,
      timeAttr,
      closed: !dlg.open,
    };
  })()`);

  assert.equal(aboutResult.width, 320, 'About modal must be 320px wide');
  assert.equal(aboutResult.height, 428, 'About modal must be 428px tall');
  assert.equal(aboutResult.beforeText, 'Version 2.42304.0 (e7f60e)');
  assert.equal(aboutResult.copiedText, 'Copied version to clipboard');
  assert.equal(aboutResult.timeAttr, '2026-10-15T05:54:05.000Z');
  assert.equal(aboutResult.closed, true);

  // 3. Sidebar collapse (Ctrl+B / #sidebar-toggle)
  const collapseResult = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('sidebar-toggle').click();
    await wait(100);
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    const sidebarDisplay = getComputedStyle(document.querySelector('.sidebar')).display;
    document.getElementById('sidebar-toggle').click();
    await wait(100);
    const restored = !document.body.classList.contains('sidebar-collapsed');
    return { collapsed, sidebarDisplay, restored };
  })()`);

  assert.equal(collapseResult.collapsed, true);
  assert.equal(collapseResult.sidebarDisplay, 'none');
  assert.equal(collapseResult.restored, true);

  // 4. Quick Entry (606px, maxlength 16384, Enter with >2 chars submits to main session)
  const quickResult = await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('quick-toggle').click();
    await wait(150);
    const dlg = document.getElementById('quick-dialog');
    const container = document.getElementById('quick-container');
    const input = document.getElementById('prompt-input');
    const rect = container.getBoundingClientRect();
    const maxLength = Number(input.getAttribute('maxlength'));
    const placeholder = input.getAttribute('placeholder');

    input.value = '快速入口端到端验证';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 80 && !document.getElementById('run-status').textContent.includes('已完成'); i++) {
      await wait(100);
    }
    return {
      width: Math.round(rect.width),
      maxLength,
      placeholder,
      closedOnSubmit: !dlg.open,
      messages: document.querySelectorAll('.message').length,
    };
  })()`);

  assert.equal(quickResult.width, 606, 'Quick Entry container must be 606px wide');
  assert.equal(quickResult.maxLength, 16384);
  assert.equal(quickResult.placeholder, 'What can I help you with today?');
  assert.equal(quickResult.closedOnSubmit, true);
  assert.equal(quickResult.messages, 2, 'Quick Entry submit must drive a real conversation turn');

  console.log(JSON.stringify({
    ok: true,
    find: findResult,
    about: aboutResult,
    collapse: collapseResult,
    quick: quickResult,
  }));

  detach?.();
  bus.dispose();
  win.destroy();
  server.closeAllConnections();
  server.close(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(0);
  });
}).catch(error => {
  console.error(error);
  try { detach?.(); } catch {}
  try { bus?.dispose(); } catch {}
  if (server) { server.closeAllConnections(); server.close(); }
  app.exit(1);
});
