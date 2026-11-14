// The application menu, and the MenuEvents it emits.
//
// The shipped build hides its menu bar but does NOT remove the menu:
//
//   Oqa(e){ e.setAutoHideMenuBar(!1), e.setMenuBarVisibility(!1) }
//   kqa(e){ Menu.setApplicationMenu(e); for (win of BrowserWindow.getAllWindows()) Oqa(win) }
//
// so the bar is invisible while the menu stays installed. That matters because an
// installed menu is what carries accelerators: `CmdOrCtrl+Shift+D` reaches the item,
// whose click handler sends a MenuEvents event, which the renderer subscribed to.
//
// This reconstruction used `win.removeMenu()`, which uninstalls the menu entirely and
// therefore kills every accelerator with it. The renderer still subscribes —
//
//   onToggleSessionPane(cb)  ->  $eipc_event$_<NS>_$_claude.web_$_MenuEvents_$_ToggleSessionPane
//   onCloseSessionPane(cb)
//   onFindInFiles(cb)
//
// (preload-frontend.cjs derives the channel from the method name: `on` + name, with
// `method.slice(2)` as the channel suffix) — but nothing ever sent on those channels,
// so every one of those subscriptions was dead.
//
// The accelerators below are the ones the original menu template declares:
//
//   Show/Hide Terminal     (no accelerator)
//   Show/Hide Changes      CmdOrCtrl+Shift+D
//   Show/Hide Preview      CmdOrCtrl+Shift+P   (CmdOrCtrl+Shift+B when it is a browser)
//   Show/Hide Files        CmdOrCtrl+Shift+F
//   Show/Hide Side Chat    CmdOrCtrl+;
//   Close Pane             CmdOrCtrl+\
//
// Only the panes this build actually has are wired: the renderer decides which pane
// exists (setSessionPaneMenuState reports enabled/open), and an event for a pane the
// UI does not offer is harmless — the handler is simply not registered.

const { Menu } = require('electron');
// Reuse the bridge's own channel builder so the event prefix and namespace cannot
// drift from the message channels.
const { eventChannel } = require('./bridge-services.cjs');

/** The pane ids the renderer's MenuEvents.toggleSessionPane carries. */
const PANE = {
  Terminal: 'terminal',
  Changes: 'diff',
  Preview: 'preview',
  Files: 'files',
  // NOT `sideChat`. The renderer's SessionPaneMenuTarget enum is
  //   { Terminal:"terminal", Diff:"diff", Preview:"preview",
  //     SideChat:"side_chat", Files:"files" }        (shared-0-ByI5P0CP.js)
  // and the menu handler switches on exactly those values:
  //   case _e.SideChat: ce && E(); return;            (c11959232-DoFe4ab2.js)
  // The camelCase spelling matched no case, so the Side Chat shortcut did nothing.
  SideChat: 'side_chat',
};

/**
 * Install the application menu and hide its bar.
 *
 * @param {object} opts
 * @param {string} opts.namespace       the EIPC namespace uuid
 * @param {() => object[]} opts.windows windows to send to
 * @param {object} opts.labels          localized labels (English defaults)
 * @returns {{ dispose: () => void, sent: Array<{name: string, args: unknown[]}> }}
 */
function installApplicationMenu({ namespace, windows, labels = {}, onCheckForUpdates } = {}) {
  const sent = [];
  const L = {
    appMenu: labels.appMenu || 'Claude',
    show: labels.show || 'Show',
    hide: labels.hide || 'Hide',
    terminal: labels.terminal || 'Terminal',
    changes: labels.changes || 'Changes',
    preview: labels.preview || 'Preview',
    files: labels.files || 'Files',
    sideChat: labels.sideChat || 'Side Chat',
    closePane: labels.closePane || 'Close Pane',
    quit: labels.quit || 'Quit',
  };

  // Channel names are PascalCase.
  //
  // preload-frontend.cjs subscribes with `method.slice(2)` as the suffix, so the
  // renderer method `onToggleSessionPane` listens on `..._$_ToggleSessionPane` —
  // capital T. Sending `toggleSessionPane` compiles, runs, and reaches nobody; the
  // namespace-parity test caught exactly that.
  const CHANNEL_NAME = {
    toggleSessionPane: 'ToggleSessionPane',
    closeSessionPane: 'CloseSessionPane',
    findInFiles: 'FindInFiles',
  };

  const sendToWindows = (name, args) => {
    const event = CHANNEL_NAME[name] || name;
    sent.push({ name: event, args });
    const channel = eventChannel('claude.web', 'MenuEvents', event);
    const list = typeof windows === 'function' ? windows() : [];
    let delivered = 0;
    for (const win of list || []) {
      if (!win || win.isDestroyed()) continue;
      try {
        win.webContents.send(channel, ...args);
        delivered += 1;
      } catch { /* tearing down */ }
    }
    // Logged because this is the only place that can prove a MENU path fired. The
    // renderer has its own keyboard shortcuts for some panes, so a pane opening is
    // not evidence by itself; a line here means an accelerator (or a menu click)
    // really ran and really sent.
    console.log(
      `[menu] send ${event} args=${JSON.stringify(args)} to ${delivered} window(s) on ${channel}`,
    );
  };

  // A pane toggle carries (pane, typed). `typed` is false here: the original only
  // sets it when the shortcut was typed to open a pane menu, which this build does
  // not have.
  const paneItem = (label, accelerator, pane) => ({
    label,
    accelerator,
    click: () => sendToWindows('toggleSessionPane', [pane, false]),
  });

  const template = [
    {
      label: L.appMenu,
      submenu: [
        { role: 'about' },
        ...(onCheckForUpdates ? [{ label: '检查更新…', accelerator: 'CmdOrCtrl+Shift+U', click: () => { Promise.resolve(onCheckForUpdates()).catch(error => console.error('[updates]', error.message)); } }] : []),
        { type: 'separator' },
        // hide / hideOthers / unhide are macOS-only roles. Electron leaves them in the menu
        // on Windows, where they render as ordinary items bound to Command+H / Command+Alt+H —
        // accelerators that can never fire. Measured on this host: of the 18 installed
        // accelerators exactly two were macOS-only, both from this block.
        ...(process.platform === 'darwin'
          ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }]
          : []),
        { label: L.quit, role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' }, { type: 'separator' },
        // The renderer owns "find in files" for the session, not Electron's find.
        { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+H', click: () => sendToWindows('findInFiles', []) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        paneItem(`${L.show} ${L.terminal}`, undefined, PANE.Terminal),
        paneItem(`${L.show} ${L.changes}`, 'CmdOrCtrl+Shift+D', PANE.Changes),
        paneItem(`${L.show} ${L.preview}`, 'CmdOrCtrl+Shift+P', PANE.Preview),
        paneItem(`${L.show} ${L.files}`, 'CmdOrCtrl+Shift+F', PANE.Files),
        paneItem(`${L.show} ${L.sideChat}`, 'CmdOrCtrl+;', PANE.SideChat),
        {
          label: L.closePane,
          accelerator: 'CmdOrCtrl+\\',
          click: () => sendToWindows('closeSessionPane', []),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Hide the BAR, keep the menu installed. This is the original's own arrangement
  // (`setMenuBarVisibility(false)`), and it is what keeps accelerators alive.
  const list = typeof windows === 'function' ? windows() : [];
  for (const win of list || []) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.setAutoHideMenuBar(false);
      win.setMenuBarVisibility(false);
    } catch { /* older Electron */ }
  }

  return {
    dispose: () => {
      try { Menu.setApplicationMenu(null); } catch { /* app quitting */ }
    },
    sent,
    /**
     * Invoke a menu item by label, the same way an accelerator does.
     *
     * A real accelerator ends in `menuItem.click()`, so calling `click()` here
     * exercises the identical path: the handler runs, `sendToWindows` fires, and the
     * renderer's MenuEvents subscription receives the event. This exists because CDP
     * input cannot reach the native menu, which otherwise leaves "the keypress works"
     * unprovable from outside the app.
     *
     * Returns { ok, label, sent } or { ok: false, error }.
     */
    click(label) {
      const find = (menu) => {
        for (const item of (menu && menu.items) || []) {
          if (item.label === label) return item;
          if (item.submenu) {
            const hit = find(item.submenu);
            if (hit) return hit;
          }
        }
        return null;
      };
      const menu = Menu.getApplicationMenu();
      const item = find(menu);
      if (!item) return { ok: false, error: `no menu item labeled ${JSON.stringify(label)}` };
      if (typeof item.click !== 'function') {
        return { ok: false, error: `menu item ${JSON.stringify(label)} has no click handler` };
      }
      const before = sent.length;
      // Electron passes (menuItem, browserWindow, event) to a click handler; the ones
      // here ignore all three.
      item.click(item, null, {});
      return { ok: true, label, sent: sent.slice(before) };
    },
    /** The labels that have accelerators, for a probe to assert against. */
    accelerators() {
      const out = [];
      const walk = (menu) => {
        for (const item of (menu && menu.items) || []) {
          if (item.accelerator) out.push({ label: item.label, accelerator: item.accelerator });
          if (item.submenu) walk(item.submenu);
        }
      };
      walk(Menu.getApplicationMenu());
      return out;
    },
  };
}

module.exports = { installApplicationMenu, PANE };
