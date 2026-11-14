// Experimental shell v2: serve the shipped ion-dist over app:// exactly as the
// original does, answer every EIPC channel generically, and record what the
// real frontend asks for so the canvas requirement set becomes explicit.
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = process.env.PROBE_ROOT || path.resolve(__dirname, '..', '..', 'full-replica', 'resources');
const ION = path.join(ROOT, 'ion-dist');
const EVID = path.resolve(__dirname, '..', '..', 'evidence', 'live');
const LOG = path.join(EVID, 'probe-calls.log');

const BRIDGE = require('./bridge-map.json');
const NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';

const calls = [];
let dirty = false;
function record(entry) { calls.push(entry); dirty = true; }
function flush() {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(LOG, calls.map((c) => JSON.stringify(c)).join('\n')); } catch {}
}

// ---- generic answers per method, so the frontend can finish booting ---------
// Keys are "<domain>_$_<Service>_$_<method>" fragments.
function answer(channel, args) {
  const frag = channel.replace(`$eipc_message$_${NAMESPACE}_$_`, '');
  // Preferences / feature gates
  if (/getPreferences$/.test(frag)) return { theme: 'light', density: 'comfortable', chatTextSize: 'm', transcriptWidth: 's', sidebarMode: 'code' };
  if (/getSupportedFeatures$/.test(frag)) return {};
  if (/getAppConfig$/.test(frag)) return { sidebarMode: 'code', deploymentMode: '3p' };
  if (/getSessionsBridgeEnabled$/.test(frag)) return false;
  if (/getBridgeConsent$/.test(frag)) return { granted: false };
  if (/getInstalledExtensionsWithState$/.test(frag)) return [];
  if (/getVisibility$/.test(frag)) return 'visible';
  if (/getFullscreen$/.test(frag)) return false;
  if (/getAppFocused$/.test(frag)) return true;
  if (/getZoomFactor$/.test(frag)) return 1;
  if (/getOnScreen$/.test(frag)) return true;
  if (/getKeptHidden$/.test(frag)) return false;
  if (/getDefaultWorkspaceFolders$/.test(frag)) return [];
  if (/getDirectMcpServerStatuses$/.test(frag)) return [];
  if (/getManagedAskToolNames$/.test(frag)) return [];
  if (/listServers$/.test(frag)) return [];
  if (/getStatus$/.test(frag)) return { status: 'unavailable' };
  if (/getSystemInfo$/.test(frag)) return { platform: process.platform, arch: process.arch, version: '2.42304.0' };
  if (/getSupportedCommands$/.test(frag)) return [];
  if (/getAll$/.test(frag)) return { sessions: [], spaces: [], tasks: [] };
  if (/getSessionList$/.test(frag)) return { sessions: [], archived: [] };
  if (/fetchAllSessions$/.test(frag)) return { sessions: [] };
  if (/getTranscript/.test(frag)) return { messages: [], entries: [] };
  if (/getLocalMcpServers$/.test(frag)) return [];
  if (/getConnectedExtensions$/.test(frag)) return [];
  if (/getLocalSkills$/.test(frag)) return [];
  if (/getDetectedProjects$/.test(frag)) return [];
  if (/getSpacesStoreState$/.test(frag)) return { spaces: [] };
  if (/getPreferences$|getState$|getStateSync$/.test(frag)) return null;
  return null;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: true, codeCache: true },
  },
]);

app.whenReady().then(async () => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'localhost') return new Response(null, { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const safe = path.normalize(rel).replace(/^([/\\])+/, '');
    if (safe.includes('..')) return new Response(null, { status: 403 });
    const target = path.join(ION, safe);
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) return net.fetch(pathToFileURL(target).toString());
    const shell = path.join(ION, 'index.html');
    if (fs.existsSync(shell)) return net.fetch(pathToFileURL(shell).toString());
    return new Response(null, { status: 404 });
  });

  // Register every method from the bridge map as a real handler.
  const registered = [];
  for (const [ns, services] of Object.entries(BRIDGE)) {
    if (ns.startsWith('__')) continue;
    for (const [service, methods] of Object.entries(services || {})) {
      if (!Array.isArray(methods)) continue;
      for (const method of methods) {
        if (method.startsWith('on') && method.length > 2) continue; // event, no handler
        const channel = `$eipc_message$_${NAMESPACE}_$_${ns}_$_${service}_$_${method}`;
        ipcMain.handle(channel, async (_event, ...args) => {
          record({ t: Date.now(), channel: `${ns}.${service}.${method}`, args: args.map(a => typeof a === 'object' ? '[obj]' : a) });
          return answer(channel, args);
        });
        registered.push(channel);
      }
    }
  }
  record({ t: Date.now(), kind: 'registered', count: registered.length });

  const win = new BrowserWindow({
    width: 1920,
    height: 1032,
    show: process.env.PROBE_SHOW === '1',
    backgroundColor: '#fcfcfb',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload-probe.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      additionalArguments: ['--desktop-features={}'],
    },
  });

  win.webContents.on('preload-error', (_e, file, err) => console.error('[preload-error]', file, err && err.message));
  win.webContents.on('console-message', (e) => {
    const rec = { t: Date.now(), kind: 'console', level: e.level, message: String(e.message).slice(0, 500) };
    record(rec);
    if (e.level === 'error' || process.env.PROBE_VERBOSE === '1') console.log(`[console:${e.level}] ${String(e.message).slice(0, 300)}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[did-fail-load]', code, desc, url));

  const url = process.env.PROBE_URL || 'app://localhost/epitaxy?coldLaunch=1';
  await win.loadURL(url).catch((e) => console.error('[load]', e.message));

  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const probe = await win.webContents.executeJavaScript(`JSON.stringify({
          url: location.href, title: document.title, ready: document.readyState,
          rootChildren: document.getElementById('root')?.children.length ?? -1,
          htmlLen: document.documentElement.outerHTML.length,
          hasDframe: !!document.querySelector('.dframe-root'),
          dframeBox: (() => { const d = document.querySelector('.dframe-root'); if (!d) return null; const b = d.getBoundingClientRect(); return [b.width, b.height]; })(),
          sidebarW: (() => { const a = document.querySelector('aside'); return a ? Math.round(a.getBoundingClientRect().width) : null; })(),
          titlebarH: (() => { const t = document.querySelector('.dframe-root > div'); return t ? Math.round(t.getBoundingClientRect().height) : null; })(),
          bodyText: (document.body.innerText || '').slice(0, 400),
        })`);
        record({ t: Date.now(), kind: 'probe', value: probe });
        console.log('PROBE ' + probe);
      } catch (e) {
        console.log('PROBE-ERR ' + e.message);
      }
      flush();
      if (process.env.PROBE_SHOT === '1') {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(EVID, 'probe-shot.png'), img.toPNG());
          console.log('shot saved');
        } catch (e) { console.log('shot failed', e.message); }
      }
      if (process.env.PROBE_KEEP !== '1') { flush(); app.exit(0); }
    }, Number(process.env.PROBE_WAIT || 20000));
  });
});

app.on('window-all-closed', () => app.quit());
