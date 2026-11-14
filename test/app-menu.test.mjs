// The renderer subscribes to MenuEvents:
//
//   onToggleSessionPane(cb)  ->  $eipc_event$_<NS>_$_claude.web_$_MenuEvents_$_ToggleSessionPane
//   onCloseSessionPane(cb)
//   onFindInFiles(cb)
//
// (preload-frontend.cjs derives the channel as `eventChannel(domain, service, method.slice(2))`.)
// Nothing in this build ever sent on those channels, because `win.removeMenu()` had
// uninstalled the menu that carries the accelerators. These tests pin the wiring:
// the accelerators exist, and firing a menu item sends the right event on the right
// channel with the right arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// app-menu requires 'electron' for Menu. Replace it with a recorder so the template
// can be built and its click handlers invoked without a real Electron runtime.
let lastTemplate = null;
const electronStub = {
  Menu: {
    buildFromTemplate: (template) => {
      lastTemplate = template;
      return { __template: template };
    },
    setApplicationMenu: (menu) => { electronStub.__installed = menu; },
  },
};
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: electronStub,
};

const { installApplicationMenu, PANE } = require('../desktop/app-menu.cjs');
const { NAMESPACE, eventChannel } = require('../desktop/bridge-services.cjs');

/** A BrowserWindow stand-in that records what was sent to its renderer. */
function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, ...args) => sent.push({ channel, args }) },
    setAutoHideMenuBar: () => {},
    setMenuBarVisibility: () => {},
  };
}

/** Depth-first search of a menu template for an item by label. */
function findItem(template, label) {
  for (const item of template) {
    if (item.label === label) return item;
    const sub = item.submenu;
    if (Array.isArray(sub)) {
      const hit = findItem(sub, label);
      if (hit) return hit;
    }
  }
  return null;
}

function allItems(template, out = []) {
  for (const item of template) {
    out.push(item);
    if (Array.isArray(item.submenu)) allItems(item.submenu, out);
  }
  return out;
}

test('the menu is installed and the bar is hidden, not removed', () => {
  // The distinction matters: removeMenu() also drops the accelerators.
  const win = fakeWindow();
  const menu = installApplicationMenu({ windows: () => [win] });
  assert.ok(electronStub.__installed, 'Menu.setApplicationMenu must be called');
  assert.equal(typeof menu.dispose, 'function');
  menu.dispose();
});

test('pane accelerators match the shipped template', () => {
  const win = fakeWindow();
  installApplicationMenu({ windows: () => [win] });
  const items = allItems(lastTemplate);

  // Accelerators observed in the original menu template (index.chunk-lzaSYO3Q.js):
  //   Changes CmdOrCtrl+Shift+D, Preview CmdOrCtrl+Shift+P, Files CmdOrCtrl+Shift+F,
  //   Side Chat CmdOrCtrl+;, Close Pane CmdOrCtrl+\\
  const byAccel = new Map(items.filter((i) => i.accelerator).map((i) => [i.accelerator, i]));
  for (const accel of ['CmdOrCtrl+Shift+D', 'CmdOrCtrl+Shift+P', 'CmdOrCtrl+Shift+F', 'CmdOrCtrl+;', 'CmdOrCtrl+\\']) {
    assert.ok(byAccel.has(accel), `missing accelerator ${accel}`);
  }
});

test('toggling a pane sends toggleSessionPane with [pane, typed]', () => {
  // The preload forwards two arguments:
  //   onToggleSessionPane(cb) { ipcRenderer.on(ch, (_e, pane, typed) => cb(pane, typed)) }
  // so the payload must be (pane, typed) — not a single object.
  const win = fakeWindow();
  installApplicationMenu({ windows: () => [win] });

  const changes = findItem(lastTemplate, 'Show Changes');
  assert.ok(changes, 'Changes item missing');
  changes.click();

  assert.equal(win.sent.length, 1);
  const [msg] = win.sent;
  assert.equal(
    msg.channel,
    eventChannel('claude.web', 'MenuEvents', 'ToggleSessionPane'),
    'channel must match what the preload subscribes to'
  );
  assert.deepEqual(msg.args, [PANE.Changes, false]);
  assert.equal(PANE.Changes, 'diff', 'the renderer keys the pane as "diff", not "changes"');
});

test('every pane toggle uses the id the renderer expects', () => {
  const win = fakeWindow();
  installApplicationMenu({ windows: () => [win] });
  // These strings are the renderer's SessionPaneMenuTarget enum values, read from
  // shared-0-ByI5P0CP.js. Note Side Chat is SN/AKE_CASE — the camelCase spelling
  // matches no `case` in the menu handler and silently does nothing.
  const cases = [
    ['Show Changes', 'diff'],
    ['Show Preview', 'preview'],
    ['Show Files', 'files'],
    ['Show Side Chat', 'side_chat'],
    ['Show Terminal', 'terminal'],
  ];
  for (const [label, pane] of cases) {
    win.sent.length = 0;
    const item = findItem(lastTemplate, label);
    assert.ok(item, `menu item "${label}" missing`);
    item.click();
    assert.equal(win.sent.length, 1, label);
    assert.equal(win.sent[0].args[0], pane, `${label} -> ${pane}`);
  }
});

test('closeSessionPane and findInFiles send no arguments', () => {
  const win = fakeWindow();
  installApplicationMenu({ windows: () => [win] });

  const closeItem = findItem(lastTemplate, 'Close Pane');
  assert.ok(closeItem, 'Close Pane missing');
  closeItem.click();
  assert.equal(
    win.sent[0].channel,
    eventChannel('claude.web', 'MenuEvents', 'CloseSessionPane')
  );
  assert.deepEqual(win.sent[0].args, []);

  win.sent.length = 0;
  const findItemNode = findItem(lastTemplate, 'Find in Files');
  assert.ok(findItemNode, 'Find in Files missing');
  findItemNode.click();
  assert.equal(
    win.sent[0].channel,
    eventChannel('claude.web', 'MenuEvents', 'FindInFiles')
  );
  assert.deepEqual(win.sent[0].args, []);
});

test('the channel uses the namespace the preload and bridge share', () => {
  // A different namespace would send into the void: the preload builds its channel
  // from NAMESPACE, so the two must agree.
  const expected = `$eipc_event$_${NAMESPACE}_$_claude.web_$_MenuEvents_$_ToggleSessionPane`;
  const win = fakeWindow();
  installApplicationMenu({ windows: () => [win] });
  findItem(lastTemplate, 'Show Changes').click();
  assert.equal(win.sent[0].channel, expected);
  assert.equal(NAMESPACE, '6010a08f-a0fa-48b4-99da-0689b9e2de7b');
});

test('a menu click reaches the window through the same channel an accelerator uses', () => {
  // An accelerator and a mouse click both end in `menuItem.click()`, so driving the
  // click handler is the same path a keyboard shortcut takes. This asserts the two
  // halves agree: what app-menu sends, and what the preload would forward.
  const win = fakeWindow();
  const menu = installApplicationMenu({ windows: () => [win] });

  // Everything a pane toggle must produce.
  findItem(lastTemplate, 'Show Changes').click();

  assert.equal(win.sent.length, 1, 'exactly one send per click');
  const [{ channel, args }] = win.sent;

  // The channel the preload subscribes to, rebuilt independently here.
  const preloadSide = `$eipc_event$_${NAMESPACE}_$_claude.web_$_MenuEvents_$_ToggleSessionPane`;
  assert.equal(channel, preloadSide);

  // The arguments the preload forwards to the renderer callback.
  assert.deepEqual(args, ['diff', false]);

  // And the module's own record says the same thing, so a probe reading either side
  // sees one story.
  assert.equal(menu.sent.length, 1);
  assert.deepEqual(menu.sent[0], { name: 'ToggleSessionPane', args: ['diff', false] });
});

test('every pane item fires exactly once with its own id', () => {
  // Guards against a copy-paste where two labels share one pane id.
  const win = fakeWindow();
  const menu = installApplicationMenu({ windows: () => [win] });
  const labels = ['Show Terminal', 'Show Changes', 'Show Preview', 'Show Files', 'Show Side Chat'];
  const seen = [];
  for (const label of labels) {
    win.sent.length = 0;
    const item = findItem(lastTemplate, label);
    assert.ok(item, label);
    item.click();
    assert.equal(win.sent.length, 1, `${label} must send once`);
    seen.push(win.sent[0].args[0]);
  }
  assert.deepEqual(seen, ['terminal', 'diff', 'preview', 'files', 'side_chat']);
  assert.equal(new Set(seen).size, seen.length, 'no two items may share a pane id');
  assert.equal(menu.sent.length, labels.length, 'the record keeps one entry per click');
});

test('the pane ids match the renderer enum, including side_chat', () => {
  // Pinned against the shipped enum so a "tidier" camelCase spelling cannot creep back:
  //
  //   shared-0-ByI5P0CP.js
  //   sy = function(e){ return e.Terminal="terminal", e.Diff="diff", e.Preview="preview",
  //                            e.SideChat="side_chat", e.Files="files", e }({})
  //
  // c11959232-DoFe4ab2.js switches on exactly these:
  //   switch (e) { case _e.Terminal: ...; case _e.Diff: n("diff"); return;
  //                case _e.SideChat: ce && E(); return; ... }
  // An unlisted spelling falls through the switch and does nothing, with no error.
  assert.equal(PANE.Terminal, 'terminal');
  assert.equal(PANE.Changes, 'diff');
  assert.equal(PANE.Preview, 'preview');
  assert.equal(PANE.Files, 'files');
  assert.equal(PANE.SideChat, 'side_chat');
  assert.notEqual(PANE.SideChat, 'sideChat', 'camelCase is not in the enum');

  // Guard the whole set: every id must be one of the enum's five values.
  const enumValues = ['terminal', 'diff', 'preview', 'side_chat', 'files'];
  for (const [name, value] of Object.entries(PANE)) {
    assert.ok(enumValues.includes(value), `${name}=${value} is not a SessionPaneMenuTarget`);
  }
});
