// System tray, and the "keep running when the window closes" behaviour it gates.
//
// The shipped build reads this preference in its main-window close handler
// (index.chunk-lzaSYO3Q.js):
//
//   p.on("close", (e) => {
//     if (TA()) return;                       // real quit requested
//     e.preventDefault();
//     if (!yv("menuBarEnabled")) {            // <- the SAME preference
//       N.info("Quitting app on main window close since tray is disabled");
//       quit();
//       return;
//     }
//     ...; p.hide();                          // tray is on: hide, keep running
//   });
//
// So "System tray" on Windows is not a cosmetic switch — it decides whether closing the
// window quits the app or hides it. The reconstruction had no tray at all and no such
// close handler, so the switch (once it had a handler) wrote a preference nothing read:
// closing the window always quit, even with the switch on.
//
// The runtime effects need Electron's Tray/window, so this module is written to be
// testable without them: the decision and the pref read are pure, and the caller injects
// the tray factory.
'use strict';

const { nativeImage, Tray, Menu } = (() => {
  try {
    return require('electron');
  } catch {
    return {};
  }
})();

/**
 * Turn an icon file into something Tray accepts, or null when it cannot be loaded.
 *
 * A Tray constructed with an empty image shows an invisible placeholder in the
 * notification area, which looks like a broken feature; refusing to create one is the
 * honest outcome.
 *
 * @param {string} file absolute path to a .png/.ico
 * @returns {object|null}
 */
function loadTrayIcon(file) {
  if (!nativeImage || typeof nativeImage.createFromPath !== 'function') return null;
  try {
    const image = nativeImage.createFromPath(file);
    if (!image || image.isEmpty()) return null;
    // Windows wants 16x16 in the notification area; a large icon is silently scaled by
    // the shell but reads as a blurry blob, so resize defensively.
    return image.resize({ width: 16, height: 16 });
  } catch { return null; }
}

/**
 * Decide what a main-window close should do.
 *
 * Extracted from the handler so the mapping is assertable: the interesting content is
 * the three-way decision, not the Electron calls around it.
 *
 * @param {{isQuitting: boolean, trayEnabled: boolean, trayAvailable: boolean}} state
 * @returns {'quit'|'hide'}
 */
function closeAction({ isQuitting, trayEnabled, trayAvailable }) {
  if (isQuitting) return 'quit';
  // The preference asks for a tray. If one could not be created, hiding the window would
  // make the app unreachable — the user would have no icon to click — so quit instead.
  if (trayEnabled && trayAvailable) return 'hide';
  return 'quit';
}

/**
 * Own the tray icon and the close-to-tray behaviour.
 *
 * @param {object} opts
 * @param {{getMainWindow: () => any, getIconPath: () => string|null, log?: (m: string) => void}} opts
 */
function createTrayController({ getMainWindow, getIconPath, log } = {}) {
  const note = typeof log === 'function' ? log : () => {};
  let tray = null;
  let isQuitting = false;

  const contextMenu = () => Menu.buildFromTemplate([
    {
      label: 'Show Claude',
      click: () => {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return;
        win.show();
        win.focus();
      },
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        const { app } = require('electron');
        app.quit();
      },
    },
  ]);

  /** Create the icon, or report why it cannot exist. */
  const ensure = () => {
    if (tray) return { ok: true };
    const file = typeof getIconPath === 'function' ? getIconPath() : null;
    if (!file) return { ok: false, reason: 'no icon path' };
    const image = loadTrayIcon(file);
    if (!image) return { ok: false, reason: 'icon could not be loaded' };
    if (typeof Tray !== 'function') return { ok: false, reason: 'no Tray in this runtime' };
    try {
      tray = new Tray(image);
      tray.setToolTip('Claude');
      tray.setContextMenu(contextMenu());
      // Clicking the icon is the shortcut users actually try first.
      tray.on('click', () => {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return;
        if (win.isVisible()) win.hide();
        else { win.show(); win.focus(); }
      });
      note('[tray] icon created');
      return { ok: true };
    } catch (error) {
      tray = null;
      return { ok: false, reason: String((error && error.message) || error) };
    }
  };

  const remove = () => {
    if (!tray) return;
    try { tray.destroy(); } catch { /* already gone */ }
    tray = null;
    note('[tray] icon destroyed');
  };

  /**
   * Apply the "System tray" preference.
   *
   * @param {boolean} enabled
   * @returns {{enabled: boolean, available: boolean, reason?: string}}
   */
  const setEnabled = (enabled) => {
    if (!enabled) {
      remove();
      return { enabled: false, available: false };
    }
    const result = ensure();
    return result.ok
      ? { enabled: true, available: true }
      : { enabled: true, available: false, reason: result.reason };
  };

  return {
    setEnabled,
    isAvailable: () => tray !== null,
    /** The decision the window's close handler should make right now. */
    closeAction: (enabled) => closeAction({
      isQuitting,
      trayEnabled: Boolean(enabled),
      trayAvailable: tray !== null,
    }),
    markQuitting: () => { isQuitting = true; },
    dispose: remove,
  };
}

module.exports = { closeAction, createTrayController, loadTrayIcon };
