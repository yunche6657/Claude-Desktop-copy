// Differential harness: boots the shipped ion-dist over app:// under a set of
// selectable conditions, so a failing configuration can be bisected against a
// known-good one instead of guessed at.
//
//   node_modules/electron/dist/electron.exe desktop/shim/bisect-main.cjs
//
// Environment:
//   BISECT_PRELOAD   probe | frontend | none     (default probe)
//   BISECT_FEATURES  empty | full                (default empty)
//   BISECT_SANDBOX   0 | 1                       (default 0)
//   BISECT_URL       target url                  (default app://localhost/epitaxy?coldLaunch=1)
//   BISECT_PORT      CDP port                    (default 9341)
//   BISECT_WAIT      ms before measuring         (default 20000)
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';
const ROOT = process.env.BISECT_ROOT || path.resolve(__dirname, '..', '..', 'resources');
const ION = path.join(ROOT, 'ion-dist');
const BRIDGE = require('./bridge-map.json');

const PRELOAD = {
  probe: path.join(__dirname, 'preload-probe.cjs'),
  frontend: path.join(__dirname, '..', 'preload-frontend.cjs'),
  none: undefined,
}[process.env.BISECT_PRELOAD || 'probe'];

const featuresArg = (process.env.BISECT_FEATURES || 'empty') === 'full'
  ? `--desktop-features=${JSON.stringify(BRIDGE.__desktopBootFeatures || {})}`
  : '--desktop-features={}';

const sandbox = (process.env.BISECT_SANDBOX || '0') === '1';
const URL_ = process.env.BISECT_URL || 'app://localhost/epitaxy?coldLaunch=1';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: true, codeCache: true } },
]);

app.whenReady().then(async () => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'localhost') return new Response(null, { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const safe = path.normalize(rel).replace(/^[/\\]+/, '');
    if (safe.includes('..')) return new Response(null, { status: 403 });
    const target = path.join(ION, safe);
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) return net.fetch(pathToFileURL(target).toString());
    // SPA fallback
    const shell = path.join(ION, 'index.html');
    return fs.existsSync(shell) ? net.fetch(pathToFileURL(shell).toString()) : new Response(null, { status: 404 });
  });

  // Same generic registration the probe used, so handler presence is constant.
  for (const [ns, services] of Object.entries(BRIDGE)) {
    if (ns.startsWith('__')) continue;
    for (const [service, methods] of Object.entries(services || {})) {
      if (!Array.isArray(methods)) continue;
      for (const method of methods) {
        if (method.startsWith('on') && method.length > 2) continue;
        ipcMain.handle(
          `$eipc_message$_${NAMESPACE}_$_${ns}_$_${service}_$_${method}`,
          async (_e, ...args) => {
            if (/getPreferences$/.test(method)) return { theme: 'light', density: 'comfortable', chatTextSize: 'm', transcriptWidth: 's', sidebarMode: 'code' };
            if (/getSupportedFeatures$/.test(method)) return {};
            if (/getAppConfig$/.test(method)) return { sidebarMode: 'code', deploymentMode: '3p' };
            if (/getSessionsBridgeEnabled$/.test(method)) return false;
            if (/getBridgeConsent$/.test(method)) return { granted: false };
            if (/getVisibility$/.test(method)) return 'visible';
            if (/getDefaultWorkspaceFolders$/.test(method)) return [];
            if (/getAll$|List$|listServers$/.test(method)) return [];
            if (/getState$|getStateSync$/.test(method)) return null;
            if (/^is|^can/.test(method)) return false;
            if (/^get|^list/.test(method)) return null;
            return null;
          },
        );
      }
    }
  }

  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1032,
    backgroundColor: '#fcfcfb',
    frame: false,
    webPreferences: {
      ...(PRELOAD ? { preload: PRELOAD } : {}),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox,
      additionalArguments: [featuresArg],
    },
  });

  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.log(`[err] ${String(e.message).slice(0, 240)}`);
  });
  win.webContents.on('preload-error', (_e, f, err) => console.log('[preload-error]', f, err && err.message));

  await win.loadURL(URL_);
  setTimeout(async () => {
    const out = await win.webContents.executeJavaScript(`JSON.stringify({
      url: location.href, title: document.title,
      hasDframe: !!document.querySelector('.dframe-root'),
      sidebarW: (() => { const a = document.querySelector('aside'); return a ? Math.round(a.getBoundingClientRect().width) : null })(),
      titlebarH: (() => { const t = document.querySelector('.dframe-root > div'); return t ? Math.round(t.getBoundingClientRect().height) : null })(),
      icons: [...document.querySelectorAll('span')].filter(s => s.children.length === 0 && /[\\uE000-\\uF8FF]/.test(s.textContent)).length,
      htmlLen: document.documentElement.outerHTML.length,
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
    })`).catch((e) => JSON.stringify({ error: e.message }));
    console.log('RESULT ' + out);
    app.exit(0);
  }, Number(process.env.BISECT_WAIT || 20000));
});

app.on('window-all-closed', () => app.exit(0));
