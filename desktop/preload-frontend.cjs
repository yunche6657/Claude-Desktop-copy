// Preload for the real frontend view (Di.CLAUDE_AI_WEB).
//
// Observed in the shipped .vite/build/mainView.js: that file is the preload of
// the BrowserWindow/WebContentsView that loads the shipped frontend, and it
// exposes each bridge namespace under its literal dotted name, e.g.
//
//   contextBridge.exposeInMainWorld('claude.web', { WindowControl: {...} })
//   contextBridge.exposeInMainWorld('claude.settings', {...})
//
// with every service method built from the channel template
//
//   $eipc_message$_<namespace>_$_<domain>_$_<Service>_$_<method>
//
// Event subscriptions are the same template with `$eipc_event$_` and an `on`
// prefix on the preload side. The bridge surface itself is enumerated in
// bridge-map.json, which was captured from a running original instance, so the
// shape exposed here is the observed one rather than an invented one.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ---- Desktop product token --------------------------------------------------
// The frontend selects its desktop branch from the user agent's `Claude/<v>`
// product token. Observed on a running original:
//
//   ... (KHTML, like Gecko) Claude/2.42304.0 Chrome/... Electron/... Safari/...
//
// With that token the frontend keeps /epitaxy, sets `data-dframe` on <html>,
// and renders the workbench. Without it, it rewrites /epitaxy to /code and
// renders the web marketing page. Electron's default UA carries this package's
// name instead, which is never a `Claude/` token.
//
// navigator.userAgent is read during the frontend's first render, which happens
// after this preload but before the document scripts, so it is stubbed here as
// well as set on the session. Every other navigator field is left untouched.
const DESKTOP_UA = process.env.CLAUDE_DESKTOP_UA
  || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.42304.0 Chrome/${process.versions.chrome} Electron/${process.versions.electron} Safari/537.36`;

// navigator.userAgent is read during the frontend's first render, which happens
// after this preload but before the document scripts. Patching the prototype
// getter is the only way to reach that read; it is applied defensively and only
// when the current value lacks the token. The descriptor is restored by
// reloading the window, never by the document itself.
try {
  if (!/\bClaude\//.test(navigator.userAgent)) {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'userAgent', {
      configurable: true,
      enumerable: true,
      get() { return DESKTOP_UA; },
    });
  }
} catch (error) {
  console.error('[preload] userAgent override failed:', error && error.message);
}

const NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';
const messageChannel = (domain, service, method) =>
  `$eipc_message$_${NAMESPACE}_$_${domain}_$_${service}_$_${method}`;
const eventChannel = (domain, service, name) =>
  `$eipc_event$_${NAMESPACE}_$_${domain}_$_${service}_$_${name}`;

const BRIDGE = require('./shim/bridge-map.json');

function buildService(domain, service, methods) {
  const out = {};
  for (const method of methods) {
    if (method.startsWith('on') && method.length > 2) {
      // Subscription: the frontend calls on<Event>(cb) and gets a detach fn.
      out[method] = (callback) => {
        const eventName = method.slice(2);
        // Native Launch events share the message prefix and lowercase the first letter.
        const channel = (domain === 'claude.web' && ['Launch', 'CCDScheduledTasks'].includes(service)) ||
          (domain === 'claude.settings' && service === 'AppPreferences' && method === 'onPreferencesChanged')
          ? messageChannel(domain, service, eventName[0].toLowerCase() + eventName.slice(1))
          : eventChannel(domain, service, eventName);
        const listener = (_event, ...args) => {
          try { callback(...args); } catch (error) { console.error('[bridge] listener failed', channel, error && error.message); }
        };
        ipcRenderer.on(channel, listener);
        return () => { try { ipcRenderer.removeListener(channel, listener); } catch {} };
      };
    } else {
      out[method] = (...args) => ipcRenderer.invoke(messageChannel(domain, service, method), ...args);
    }
  }
  return out;
}

function expose(name, value) {
  try {
    contextBridge.exposeInMainWorld(name, value);
  } catch (error) {
    console.error(`[preload] expose ${name} failed:`, error && error.message);
  }
}

// ---- EIPC namespaces -------------------------------------------------------
for (const [namespace, services] of Object.entries(BRIDGE)) {
  if (namespace.startsWith('__')) continue;
  const api = {};
  for (const [service, methods] of Object.entries(services || {})) {
    if (!Array.isArray(methods)) continue;
    api[service] = buildService(namespace, service, methods);
    if (namespace === 'claude.web' && service === 'Launch') {
      api[service].activeServersStore = require('./service-store.cjs')
        .createStoreBridge(ipcRenderer, namespace, service, 'activeServers');
    }
  }
  expose(namespace, api);
}

// ---- Plain globals the frontend reads directly ------------------------------
// Captured verbatim from a running original instance: these are values, not
// services, so they are exposed as-is.
//
// contextBridge cannot carry `undefined` members or functions inside plain
// data, and a single offending value makes the whole expose call throw — which
// would leave the frontend with no bridge at all. The captured payloads
// therefore go through a sanitiser that converges undefined/null to null and
// recurses into arrays and objects.
function plain(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = plain(value[key]);
    return out;
  }
  return value;
}

// Cowork is gated on the packaging check described in packaging-signals.cjs.
// The captured map records the state of the machine it came from, where that
// check failed ("msix_required"), which is why Cowork was disabled. A run that
// declares the packaging state reports it as supported instead.
function withPackaging(features) {
  let declared;
  try { declared = require('./packaging-signals.cjs').packagingState(); }
  catch { return features; }
  if (!declared.isMsix) return features;

  const out = { ...features };
  // yukonSilver is the "modern installer" gate; on a packaged install it is
  // supported, which is what the declared packaging state represents.
  for (const key of ['yukonSilver', 'yukonSilverGems', 'yukonSilverGemsCache']) {
    if (out[key]) out[key] = { status: 'supported' };
  }
  // coworkBrowser gates the Cowork mode pill itself. The captured value is
  // `unsupported/unknown` because the machine it came from had no browser
  // integration; a packaged install reports it supported.
  if (out.coworkBrowser) out.coworkBrowser = { status: 'supported' };
  // R653: the captured map also records selfHostedCowork and the cowork* feature rows as unavailable, because the
  // machine it came from could not run them. Any status that is not 'supported' renders as a disabled pill or a
  // "requires a newer installation" tooltip, so a declared desktop build reports the Cowork family as supported —
  // the handlers behind it now exist (R652).
  for (const key of Object.keys(out)) {
    if (!/^cowork|^selfHostedCowork/.test(key)) continue;
    if (out[key] && typeof out[key] === 'object' && out[key].status !== 'supported') {
      out[key] = { status: 'supported' };
    }
  }
  return out;
}

// The account row's primary line comes from the deployment display name:
//   xz() reads Uo()?.deploymentDisplayName / deploymentDisplaySubtitle
//   (shared-19-DQ7bbG4j.js), and Uo() reads desktopManagedConfig.
// The captured payload has both fields null, which collapses the row to its icon
// alone. Fill them from the 3p configuration when one is present.
function withDeploymentName(managed) {
  const out = { ...managed };
  // Extension policy is NOT overridden here.
  //
  // I tried adding `extensionsEnabled: true` at this point and then reverted it: the captured
  // `__desktopManagedConfig` already carries extensionsEnabled / localExtensionInstallAllowed /
  // unpackedExtensionInstallAllowed, and all three are FALSE in the captured payload. That
  // payload is data observed from a real instance, so false is the faithful value — overriding
  // it to true would have made the reconstruction diverge from the thing it reconstructs.
  //
  // Recorded because the investigation was instructive: the shipped frontend reads
  //   extensionsEnabled: desktopManagedConfig?.extensionsEnabled      (shared-0-DDOOdL6P.js, OC)
  // and c51dd312d-DzbHW52m.js falls back to { isExtensionsEnabled: false } when the field is not
  // a boolean. With the captured false, extensions are reported disabled — matching upstream.
  //
  // Note the asymmetry that made this look like a bug: if the Extensions namespace were absent
  // entirely the frontend would default to TRUE. Registering the bridge is what surfaces the
  // captured policy. Both behaviours are upstream's; only the captured value decides the answer.

  if (out.deploymentDisplayName && out.deploymentDisplaySubtitle) return out;
  try {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dirs = process.env.CLAUDE_RECONSTRUCTION_CONFIG_DIR ? [process.env.CLAUDE_RECONSTRUCTION_CONFIG_DIR] : [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CodeDesktop-Reconstruction', 'configLibrary') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Claude-3p', 'configLibrary') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'code-desktop-reconstruction', 'configLibrary') : null,
    ].filter(Boolean);
    let config = null;
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const file = fs.readdirSync(dir).find((f) => f.endsWith('.json') && f !== '_meta.json');
      if (!file) continue;
      config = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      break;
    }
    out.deploymentDisplayName = config?.deploymentDisplayName
      || out.deploymentDisplayName
      || os.userInfo().username;
    out.deploymentDisplaySubtitle = config?.deploymentDisplaySubtitle
      || out.deploymentDisplaySubtitle
      || (config?.inferenceProvider === 'gateway' ? 'Gateway' : null);
    // (Extension policy is intentionally not touched here; see the note at the top.)
  } catch (error) {
    console.error('[preload] deployment name resolution failed:', error && error.message);
  }
  return out;
}

expose('desktopBootFeatures', plain(withPackaging(BRIDGE.__desktopBootFeatures || {})));
// ---- electronWindowControl ---------------------------------------------------
// The shipped renderer opens Settings with
//
//   function Er(){ return window.electronWindowControl?.openSettingsWindow?.() }
//
// Measured: the global was absent, so Cmd/Ctrl+, did nothing at all — optional chaining
// swallowed the missing method, no error, no navigation. It also drives the title-bar
// buttons and the Quick Entry windows.
//
// `claude.internal.ui` is not part of the shipped bridge map, so the loop above never
// builds it; the channels still exist because main-services.cjs registers that service.
// The invoke channel name is constructed here the same way buildService does it.
const internalChannel = (service, method) => messageChannel('claude.internal.ui', service, method);
const windowInvoke = (method) => () => ipcRenderer.invoke(internalChannel('MainWindowTitleBar', method));

expose('electronWindowControl', {
  minimize: windowInvoke('minimize'),
  maximize: windowInvoke('maximize'),
  unmaximize: windowInvoke('unmaximize'),
  toggleMaximize: windowInvoke('toggleMaximize'),
  close: windowInvoke('close'),
  getWindowState: windowInvoke('getWindowState'),
  // Settings: this shell has one window, so opening Settings routes it.
  openSettingsWindow: windowInvoke('openSettingsWindow'),
  // Quick Entry is a separate window this shell does not provide. Reporting them as
  // no-ops keeps the call sites from throwing while telling the truth: nothing opens.
  openQuickEntryWindow: async () => ({ ok: false, reason: 'quick-entry-window-unavailable' }),
  getQuickEntryPayload: async () => null,
  show: async () => ({ ok: false, reason: 'no-secondary-window' }),
  focus: async () => ({ ok: false, reason: 'no-secondary-window' }),
  setIncognitoMode: async () => ({ ok: false, reason: 'no-secondary-window' }),
  onWindowStateChanged: () => () => {},
});

expose('desktopManagedConfig', plain(withDeploymentName(BRIDGE.__desktopManagedConfig || {})));
expose('desktopEnterpriseConfig', plain(BRIDGE.__desktopEnterpriseConfig || {}));
expose('desktopTelemetryConfig', plain(BRIDGE.__desktopTelemetryConfig || {}));
expose('desktopDeviceClass', 'gt16');
expose('desktopPreferredLanguages', ['zh-Hans-CN']);
expose('desktopBootPlaceholder', { status: 'supported' });

expose('claudeDesktopArtifactWindowOpenGate', { isActive: () => false });
expose('claudeAppBindings', {
  registerBinding: () => () => {},
  unregisterBinding: () => {},
  listMcpServers: async () => [],
  connectToMcpServer: async () => ({ ok: false }),
  openMcpSettings: async () => {},
});
expose('claudeAppSettings', { filePickers: { getPathForFile: () => null } });

// ---- Persisted stores -------------------------------------------------------
// The frontend picks the surface it mounts from its persisted stores as well as
// from preferences. In a fresh profile those keys do not exist yet, so the Code
// surface resolves no folder and stays on its loading placeholder. The seeds
// mirror what a running original holds (ccd-session-store v5, ccd-sync-owner,
// code-session-presets-latch, dframe-store with sidebarWidth 288).
//
// Preload code runs before the document's own scripts, so nothing has read
// these keys yet when they are written.
try {
  const { buildSeeds } = require('./store-seed.cjs');
  // The stored folder matters: with `selectedFolder: null` the recents list has no
  // working directory to group under and renders its empty state.
  const workspace = process.env.CLAUDE_WORKSPACE || process.cwd();
  const seeds = buildSeeds({ accountUuid: '00000000-0000-4000-8000-000000000001', selectedFolder: workspace, sidebarWidth: 288 });
  for (const [key, value] of seeds) {
    try {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    } catch { /* storage unavailable on this origin; the frontend creates its own */ }
  }
} catch (error) {
  console.error('[preload] store seeding failed:', error && error.message);
}
