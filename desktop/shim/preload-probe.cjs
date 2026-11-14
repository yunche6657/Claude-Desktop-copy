// Minimal preload: expose the real bridge namespaces so ion-dist can boot,
// wiring every method to the shim's generic invoke. This is the scaffolding
// used to discover, at runtime, which bridge calls the real frontend actually
// makes before any of them can be answered.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';
const ch = (domain, service, method) =>
  `$eipc_message$_${NAMESPACE}_$_${domain}_$_${service}_$_${method}`;
const ev = (domain, service, name) =>
  `$eipc_event$_${NAMESPACE}_$_${domain}_$_${service}_$_${name}`;

// Namespace -> service -> method names, taken from the live instance.
const BRIDGE = require('./bridge-map.json');

const listeners = new Map();

function makeService(domain, service, methods) {
  const out = {};
  for (const m of methods) {
    if (m.startsWith('on') && m.length > 2) {
      // event subscription: returns an unsubscribe function
      out[m] = (cb) => {
        const channel = ev(domain, service, m.slice(2));
        const fn = (_e, payload) => { try { cb(payload); } catch {} };
        ipcRenderer.on(channel, fn);
        return () => ipcRenderer.removeListener(channel, fn);
      };
    } else {
      out[m] = (...args) => ipcRenderer.invoke(ch(domain, service, m), ...args);
    }
  }
  return out;
}

// Build the exposed objects. Key names are the literal dotted globals.
const exposed = {};
for (const [ns, services] of Object.entries(BRIDGE)) {
  if (ns.startsWith('__')) continue;
  const obj = {};
  for (const [service, methods] of Object.entries(services || {})) {
    if (!Array.isArray(methods)) { continue; }
    obj[service] = makeService(ns, service, methods);
  }
  exposed[ns] = obj;
  try {
    contextBridge.exposeInMainWorld(ns, obj);
  } catch (e) {
    console.error('[shim] expose failed', ns, e.message);
  }
}

// Non-EIPC globals read directly by the frontend (plain values, no methods).
const plain = (k, v) => { try { contextBridge.exposeInMainWorld(k, v); } catch (e) { console.error('[shim] plain failed', k, e.message); } };
plain('desktopBootFeatures', BRIDGE.__desktopBootFeatures || {});
plain('desktopManagedConfig', BRIDGE.__desktopManagedConfig || {});
plain('desktopEnterpriseConfig', BRIDGE.__desktopEnterpriseConfig || {});
plain('desktopTelemetryConfig', BRIDGE.__desktopTelemetryConfig || {});
plain('desktopDeviceClass', 'gt16');
plain('desktopPreferredLanguages', ['zh-Hans-CN']);
plain('desktopBootPlaceholder', { status: 'supported' });
plain('claudeDesktopArtifactWindowOpenGate', { isActive: () => false });
plain('claudeAppBindings', {
  registerBinding: () => () => {},
  unregisterBinding: () => {},
  listMcpServers: async () => [],
  connectToMcpServer: async () => ({ ok: false }),
  openMcpSettings: async () => {},
});
plain('claudeAppSettings', { filePickers: { getPathForFile: () => null } });
