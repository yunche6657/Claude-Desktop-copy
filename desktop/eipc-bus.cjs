// EIPC protocol bus.
//
// Reconstructed from the shipped Claude 2.42304.0 app.asar
// (SHA-256 8f4d3dec5e4f3ddffb150321060b18807d83a40f3a65618fe4f29325379da9db).
// The original generates every channel through @ant/ipc-codegen, so channel
// names are not literals in the bundle; they are built from a fixed template:
//
//   $eipc_message$_<namespace uuid>_$_<domain>_$_<service>_$_<method>
//   $eipc_event$_<namespace uuid>_$_<domain>_$_<service>_$_<event>
//
// Observed namespace uuids in the bundle: 6010a08f-a0fa-48b4-99da-0689b9e2de7b
// (claude.telemetry, claude.designPdf, claude.internal.localExecConsent) and
// fcb91d11-972d-4fd6-b90b-72739699bff5 (electron_window / WindowManager).
// This reconstruction uses one namespace for its own services; the template and
// the view-registry sender check are what carry over, not the uuid.
'use strict';

const EIPC_NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';

// View identities observed in the shipped bundle's Di enum.
const VIEW = Object.freeze({
  MAIN_WINDOW: 'main-window',
  CLAUDE_AI_WEB: 'claude.ai-web',
  FIND_IN_PAGE: 'find-in-page',
  ABOUT: 'about',
  QUICK_ENTRY: 'quick-entry-window',
  CUSTOM3P_SETUP: 'custom3p-setup',
  CUSTOM3P_DEVICE_CODE: 'custom3p-device-code',
});

function buildMessageChannel(domain, service, method) {
  return `$eipc_message$_${EIPC_NAMESPACE}_$_${domain}_$_${service}_$_${method}`;
}

function buildEventChannel(domain, service, eventName) {
  return `$eipc_event$_${EIPC_NAMESPACE}_$_${domain}_$_${service}_$_${eventName}`;
}

class EipcBus {
  // `ipcMain` is injected rather than required so the bus can be exercised
  // outside the Electron runtime.
  constructor(ipcMain = require('electron').ipcMain) {
    this.ipcMain = ipcMain;
    // webContents -> view identity. A WeakMap keeps destroyed windows collectable.
    this.views = new WeakMap();
    this.channels = new Map();
  }

  registerView(webContents, view) {
    this.views.set(webContents, view);
  }

  viewOf(webContents) {
    return this.views.get(webContents) ?? null;
  }

  // The original validates the sending view before dispatching a request. An
  // unregistered sender is rejected rather than trusted, which is the stricter
  // reading of the observed behaviour.
  registerService(domain, service, methods, { allowedViews = null } = {}) {
    const registered = [];
    for (const [method, fn] of Object.entries(methods)) {
      const channel = buildMessageChannel(domain, service, method);
      if (this.channels.has(channel)) this.ipcMain.removeHandler(channel);
      const handler = async (event, ...args) => {
        const view = this.viewOf(event.sender);
        if (view === null) throw new Error(`EIPC: unregistered sender for ${domain}.${service}.${method}`);
        if (allowedViews && !allowedViews.includes(view)) {
          throw new Error(`EIPC: view "${view}" may not call ${domain}.${service}.${method}`);
        }
        return await fn(event, ...args);
      };
      this.channels.set(channel, handler);
      this.ipcMain.handle(channel, handler);
    }
    return registered;
  }

  emit(target, domain, service, eventName, payload) {
    if (!target || target.isDestroyed()) return false;
    target.send(buildEventChannel(domain, service, eventName), payload);
    return true;
  }

  // Idempotent teardown so repeated app quits and tests cannot leak handlers.
  dispose() {
    for (const channel of this.channels.keys()) this.ipcMain.removeHandler(channel);
    this.channels.clear();
  }
}

module.exports = { EIPC_NAMESPACE, VIEW, EipcBus, buildMessageChannel, buildEventChannel };
