// Capture the real console errors + failed requests while the shipped
// frontend boots, so a boot failure has an actual cause instead of a guess.
//
//   node_modules/electron/dist/electron.exe desktop/shim/diag-main.cjs
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';
const ROOT = process.env.DIAG_ROOT || path.resolve(__dirname, '..', '..', 'resources');
const ION = path.join(ROOT, 'ion-dist');
const BRIDGE = require('./bridge-map.json');
const OUT = process.env.DIAG_OUT || path.resolve(__dirname, '..', '..', 'evidence', 'live', 'diag.log');

const lines = [];
const say = (s) => { lines.push(s); console.log(s); if (lines.length % 10 === 0) fs.writeFileSync(OUT, lines.join('\n')); };

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: true, codeCache: true } },
]);

app.whenReady().then(async () => {
  const served = [];
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    served.push(url.pathname);
    if (url.hostname !== 'localhost') return new Response(null, { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const safe = path.normalize(rel).replace(/^[/\\]+/, '');
    if (safe.includes('..')) return new Response(null, { status: 403 });
    const target = path.join(ION, safe);
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
      return net.fetch(pathToFileURL(target).toString());
    }
    const shell = path.join(ION, 'index.html');
    if (fs.existsSync(shell)) return net.fetch(pathToFileURL(shell).toString());
    return new Response(null, { status: 404 });
  });

  // Register all bridge channels.
  for (const [ns, services] of Object.entries(BRIDGE)) {
    if (ns.startsWith('__')) continue;
    for (const [service, methods] of Object.entries(services || {})) {
      if (!Array.isArray(methods)) continue;
      for (const method of methods) {
        if (method.startsWith('on') && method.length > 2) continue;
        ipcMain.handle(`$eipc_message$_${NAMESPACE}_$_${ns}_$_${service}_$_${method}`, async (_e, ...args) => {
          if (/getPreferences$/.test(method)) return { theme: 'light', density: 'comfortable', chatTextSize: 'm', transcriptWidth: 's', sidebarMode: 'code' };
          if (/getSupportedFeatures$/.test(method)) return {};
          if (/getAppConfig$/.test(method)) return { sidebarMode: 'code', deploymentMode: '3p' };
          if (/getVisibility$/.test(method)) return 'visible';
          if (/getDefaultWorkspaceFolders$/.test(method)) return [];
          if (/^is|^can/.test(method)) return false;
          if (/getAll$|List$|listServers$/.test(method)) return [];
          return null;
        });
      }
    }
  }

  const win = new BrowserWindow({
    show: false, width: 1920, height: 1032, backgroundColor: '#fcfcfb', frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-probe.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
      additionalArguments: ['--desktop-features={}'],
    },
  });

  win.webContents.on('console-message', (e) => {
    say(`[console:${e.level}] ${String(e.message).slice(0, 700)}`);
  });
  win.webContents.on('preload-error', (_e, f, err) => say(`[preload-error] ${f} :: ${err && err.message}`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => say(`[did-fail-load] ${code} ${desc} ${url}`));

  session.defaultSession.webRequest.onCompleted({ urls: ['*://*/*'] }, (d) => {
    if (d.statusCode >= 400) say(`[http ${d.statusCode}] ${d.method} ${d.url}`);
  });
  session.defaultSession.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (d) => {
    say(`[net-error] ${d.error} ${d.url}`);
  });

  await win.loadURL(process.env.DIAG_URL || 'app://localhost/epitaxy?coldLaunch=1');

  setTimeout(async () => {
    const info = await win.webContents.executeJavaScript(`JSON.stringify({
      url: location.href,
      hasDframe: !!document.querySelector('.dframe-root'),
      scriptSrcs: [...document.scripts].map(s => s.src).filter(Boolean),
      scriptsLoaded: performance.getEntriesByType('resource').filter(e => e.initiatorType === 'script').length,
      resourceCount: performance.getEntriesByType('resource').length,
      errors: (window.__diagErrors || []).slice(0, 20),
    })`).catch((e) => JSON.stringify({ error: e.message }));
    say('INFO ' + info);
    say('SERVED ' + JSON.stringify([...new Set(served)]) + ` (total ${served.length})`);
    fs.writeFileSync(OUT, lines.join('\n'));
    app.exit(0);
  }, Number(process.env.DIAG_WAIT || 20000));
});

app.on('window-all-closed', () => app.exit(0));
