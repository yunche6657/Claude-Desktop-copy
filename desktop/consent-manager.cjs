// Consent window manager.
//
// Behaviour taken from the shipped app.asar (index.chunk-JnLh1fOe.js):
//
//   kind          height  modal  takesFocus  timeout   guardsCancel
//   connect       220     yes    yes         600000    no
//   disconnect    300     yes    yes         600000    no
//   apply         400     no     no          infinite  yes
//   chat-grant    240     no     no          120000    no
//
// Prompts are serialised through a concurrency-1 queue, and each prompt has a
// deadline: if the window cannot open before it, the prompt resolves "timeout"
// without ever showing a dialog. This reconstruction implements the
// `run-command` and `apply` kinds; the direct-MCP kinds need an MCP host that
// does not exist here, so they are refused instead of being faked.
'use strict';

const path = require('node:path');
const { BrowserWindow, app } = require('electron');

const EIPC_NAMESPACE = '6010a08f-a0fa-48b4-99da-0689b9e2de7b';
const CHOOSE_CHANNEL =
  `$eipc_message$_${EIPC_NAMESPACE}_$_claude.internal.localExecConsent_$_LocalExecConsent_$_choose`;

const DEFAULT_TIMEOUT_MS = 600_000;

// Only these kinds can be honoured by this reconstruction.
const KINDS = {
  'run-command': { height: 260, modal: true, takesFocus: true, timeoutMs: DEFAULT_TIMEOUT_MS, guardsCancel: false },
  apply: { height: 400, modal: false, takesFocus: false, timeoutMs: Infinity, guardsCancel: true },
};

const UNSUPPORTED_KINDS = new Set(['connect', 'disconnect', 'chat-grant']);

class ConsentManager {
  constructor({ parentWindow, ipcMain, getParentWindow, subscribeParentChanges, requireVisible = true }) {
    this.parentWindow = parentWindow;
    this.ipcMain = ipcMain;
    this.getParentWindow = getParentWindow || (() => this.parentWindow);
    this.dynamicParent = typeof getParentWindow === 'function';
    this.hasParentSource = typeof getParentWindow === 'function' || parentWindow != null;
    this.subscribeParentChanges = subscribeParentChanges;
    this.requireVisible = requireVisible;
    this.cancelParentWait = null;
    this.queue = Promise.resolve();
    this.pending = null;
    this.registered = false;
    this.disposed = false;
    this.generation = 0;
  }

  // The original validates the sender frame: it must be a top-level frame on
  // localhost (unpackaged) or file: (packaged). A nested frame is rejected.
  //
  // `senderFrame.parent` is null for a top-level frame in some Electron builds
  // and undefined in others, so the check is "no parent", not "parent === null".
  isTrustedSender(event) {
    const frame = event.senderFrame;
    if (!frame || !frame.url) return false;
    let url;
    try { url = new URL(frame.url); } catch { return false; }
    if (frame.parent) return false;
    if (app.isPackaged) return url.protocol === 'file:';
    return url.protocol === 'file:'
      || url.hostname === 'localhost'
      || url.hostname === '127.0.0.1';
  }

  register() {
    if (this.registered) return;
    this.ipcMain.handle(CHOOSE_CHANNEL, (event, decision) => {
      if (!this.isTrustedSender(event)) {
        throw new Error('consent: untrusted sender frame');
      }
      if (!this.pending || event.sender !== this.pending.window.webContents) {
        throw new Error('consent: untrusted sender frame');
      }
      if (decision !== 'allow' && decision !== 'cancel') {
        throw new Error(`consent: unsupported decision ${String(decision)}`);
      }
      const { shownAt, guardsCancel } = this.pending;
      if ((decision === 'allow' || guardsCancel) && Date.now() - shownAt < 500) {
        return { ok: false, reason: 'input-protected' };
      }
      return this.resolve(decision);
    });
    this.registered = true;
    this.disposed = false;
  }

  resolve(decision) {
    if (!this.pending) return { ok: false, reason: 'no-pending-prompt' };
    const { settle } = this.pending;
    this.pending = null;
    settle(decision);
    return { ok: true, decision };
  }

  /**
   * Shows a prompt and resolves with 'allow' | 'cancel' | 'timeout' | 'error'.
   * Prompts are serialised so two requests cannot race for one window.
   */
  ask(request, { timeoutMs, userAction = false } = {}) {
    if (this.disposed) return Promise.resolve('cancel');
    const generation = this.generation;
    const spec = KINDS[request.kind];
    const deadline = Date.now() + (spec ? Math.min(timeoutMs ?? spec.timeoutMs, spec.timeoutMs) : (timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const run = () => this.disposed || generation !== this.generation
      ? 'cancel' : this.#show(request, deadline, userAction, generation);
    const result = this.queue.then(run, run);
    // Keep the chain alive even when a prompt rejects.
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #waitForParent(deadline) {
    if (!this.hasParentSource) return Promise.resolve({ parent: undefined });
    return new Promise(resolve => {
      let done = false, watched, unsubscribe, timer, poll;
      const events = ['show', 'restore', 'focus', 'closed'];
      const unwatch = () => {
        if (watched) for (const event of events) watched.removeListener?.(event, check);
        watched = undefined;
      };
      const finish = result => {
        if (done) return;
        done = true;
        unwatch();
        unsubscribe?.();
        clearTimeout(timer);
        clearInterval(poll);
        if (this.cancelParentWait === cancel) this.cancelParentWait = null;
        resolve(result);
      };
      const cancel = () => finish({ status: 'cancel' });
      const check = () => {
        if (Date.now() >= deadline) return finish({ status: 'timeout' });
        const parent = this.getParentWindow();
        if (!this.dynamicParent && parent?.isDestroyed?.()) return finish({ status: 'cancel' });
        if (parent && !parent.isDestroyed?.() && (parent.getOpacity?.() ?? 1) > 0 &&
            (!this.requireVisible || ((parent.isVisible?.() ?? true) && !parent.isMinimized?.()))) {
          return finish({ parent });
        }
        if (watched !== parent) {
          unwatch();
          watched = parent;
          if (watched) for (const event of events) watched.on?.(event, check);
        }
      };
      this.cancelParentWait = cancel;
      if (Number.isFinite(deadline)) timer = setTimeout(() => finish({ status: 'timeout' }), Math.max(0, deadline - Date.now()));
      // Opacity changes have no corresponding BrowserWindow event.
      poll = setInterval(check, 100);
      if (this.subscribeParentChanges) {
        unsubscribe = this.subscribeParentChanges(check);
        if (done) unsubscribe?.();
      }
      if (!done) check();
    });
  }

  async #show(request, deadline, userAction, generation) {
    const spec = KINDS[request.kind];
    if (!spec) {
      if (UNSUPPORTED_KINDS.has(request.kind)) {
        throw new Error(`consent: kind "${request.kind}" requires an MCP host, which is not implemented`);
      }
      throw new Error(`consent: unknown kind "${String(request.kind)}"`);
    }

    if (Date.now() >= deadline) return 'timeout';

    let parent;
    while (true) {
      const ready = await this.#waitForParent(deadline);
      if (this.disposed || generation !== this.generation) return 'cancel';
      if (ready.status) return ready.status;
      if (Date.now() >= deadline) return 'timeout';
      parent = ready.parent;
      if (!this.hasParentSource || (parent === this.getParentWindow() && parent &&
          !parent.isDestroyed?.() && (parent.getOpacity?.() ?? 1) > 0 &&
          (!this.requireVisible || ((parent.isVisible?.() ?? true) && !parent.isMinimized?.())))) break;
    }

    const query = buildQuery(request);
    let win;
    try { win = new BrowserWindow({
      width: 460,
      height: spec.height,
      parent: parent ?? undefined,
      modal: spec.modal && parent != null,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: '#f9f9f7',
      webPreferences: {
        preload: path.join(__dirname, 'consent', 'preload-consent.cjs'),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    }); } catch { return 'error'; }
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());

    let parentFocusHandler, focusedAtClose = false;
    const removeParentFocus = () => { if (parentFocusHandler) { parent?.removeListener?.('focus', parentFocusHandler); parentFocusHandler = undefined; } };
    const decision = await new Promise(resolve => {
      let settled = false, finished = false, decisionValue = 'cancel', fallback;
      let timer;
      const finish = () => {
        if (finished) return;
        finished = true; clearTimeout(timer); clearTimeout(fallback); resolve(decisionValue);
      };
      const settle = value => {
        if (settled) return;
        settled = true; decisionValue = value; clearTimeout(timer);
        if (win.isDestroyed()) { finish(); return; }
        fallback = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); finish(); }, 5000);
        fallback?.unref?.();
        if (typeof win.close === 'function') win.close();
        else { focusedAtClose ||= win.isFocused?.() === true; win.destroy(); }
        if (win.isDestroyed()) finish();
      };
      this.pending = { settle, window: win, shownAt: Infinity, guardsCancel: spec.guardsCancel };
      win.on('focus', () => { removeParentFocus(); if (this.pending?.window === win) this.pending.shownAt = Date.now(); });
      win.on('close', () => { focusedAtClose = win.isFocused?.() === true; });
      win.webContents.on('before-input-event', (event, input) => {
        if (!spec.guardsCancel || input.type !== 'keyDown' || !(input.meta || input.control) ||
            !(input.key?.toLowerCase() === 'w' || input.code === 'KeyW')) return;
        const shownAt = this.pending?.window === win ? this.pending.shownAt : Infinity;
        if (input.isAutoRepeat || Date.now() - shownAt < 500) event.preventDefault();
      });

      timer = Number.isFinite(deadline)
        ? setTimeout(() => settle('timeout'), Math.max(0, deadline - Date.now()))
        : undefined;

      win.on('closed', () => { if (!settled) { settled = true; decisionValue = 'cancel'; } finish(); });
      win.webContents.once('did-fail-load', (_event, _code, _description, _url, isMainFrame) => settle(isMainFrame === true ? 'error' : 'cancel'));
      win.once('ready-to-show', () => {
        if (settled || win.isDestroyed()) return;
        const takeFocus = spec.takesFocus || (userAction && BrowserWindow.getFocusedWindow?.() != null);
        if (takeFocus) { win.show(); win.focus?.(); }
        else {
          win.showInactive(); win.flashFrame?.(true); app.dock?.bounce?.('informational');
          if (userAction && parent?.once) {
            parentFocusHandler = () => { parentFocusHandler = undefined; if (!settled && !win.isDestroyed()) win.focus?.(); };
            parent.once('focus', parentFocusHandler);
          }
        }
        if (this.pending?.window === win) this.pending.shownAt = Date.now();
      });
      try {
        Promise.resolve(win.loadFile(path.join(__dirname, 'consent', 'localExecConsent.html'), { query }))
          .catch(() => settle('error'));
      } catch { settle('error'); }

    });

    if (this.pending?.window === win) this.pending = null;
    removeParentFocus();
    if (!win.isDestroyed()) { focusedAtClose ||= win.isFocused?.() === true; win.destroy(); }
    if (focusedAtClose && parent && !parent.isDestroyed?.() && parent.isVisible?.()) parent.focus?.();
    return decision;
  }

  dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.generation++;
    }
    this.cancelParentWait?.();
    if (this.registered) {
      this.ipcMain.removeHandler(CHOOSE_CHANNEL);
      this.registered = false;
    }
    if (this.pending) {
      const { settle } = this.pending;
      this.pending = null;
      settle('cancel');
    }
  }
}

// Query keys mirror the original: kind plus kind-specific fields, all strings.
function buildQuery(request) {
  const query = { kind: request.kind };
  if (request.kind === 'run-command') {
    query.command = request.command;
    if (request.cwd) query.cwd = request.cwd;
    if (request.toolName) query.toolName = request.toolName;
  }
  if (request.kind === 'apply') {
    query.targets = JSON.stringify(request.targets.map(target => ({
      display: target.display,
      detail: target.detail,
      ...(target.origin ? { origin: target.origin } : {}),
    })));
  }
  return query;
}

module.exports = { ConsentManager, CHOOSE_CHANNEL, KINDS, UNSUPPORTED_KINDS, buildQuery };
