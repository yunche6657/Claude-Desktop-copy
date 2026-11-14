'use strict';

// Original mainView.js @106756 uses the MESSAGE prefix for store updates too.
// Stores are separate from the method/event inventory in bridge-map.json.
const PREFIX = '$eipc_message$_6010a08f-a0fa-48b4-99da-0689b9e2de7b_$_';
const storeChannel = (domain, service, name, operation) =>
  `${PREFIX}${domain}_$_${service}_$_${name}_$store$_${operation}`;

function createStoreBridge(ipcRenderer, domain, service, name) {
  const channel = operation => storeChannel(domain, service, name, operation);
  return {
    getState: () => ipcRenderer.invoke(channel('getState')),
    getStateSync() {
      const reply = ipcRenderer.sendSync(channel('getStateSync'));
      if (reply == null) throw new Error('No reply from the main process for sync store IPC');
      if (reply.error) throw new Error(reply.error);
      return reply.result;
    },
    onStateChange(callback) {
      if (typeof callback !== 'function') throw new TypeError('Store subscriber must be a function');
      const listener = (_event, state) => callback(state);
      ipcRenderer.on(channel('update'), listener);
      return () => ipcRenderer.removeListener(channel('update'), listener);
    },
  };
}

function registerServiceStore({ ipcMain, domain, service, name, getState, send }) {
  const channel = operation => storeChannel(domain, service, name, operation);
  const snapshot = () => {
    const state = getState();
    if (state && typeof state.then === 'function') throw new Error('Sync store requires a synchronous snapshot');
    return state;
  };
  const syncListener = event => {
    try { event.returnValue = { result: snapshot() }; }
    catch (error) { event.returnValue = { error: String(error.message || error) }; }
  };
  ipcMain.handle(channel('getState'), () => snapshot());
  // Minimal method-only hosts have no synchronous transport; Electron does.
  ipcMain.on?.(channel('getStateSync'), syncListener);
  let disposed = false;
  return {
    publish() {
      if (disposed) return false;
      send(channel('update'), snapshot());
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ipcMain.removeHandler(channel('getState'));
      ipcMain.removeListener?.(channel('getStateSync'), syncListener);
    },
  };
}

module.exports = { storeChannel, createStoreBridge, registerServiceStore };
