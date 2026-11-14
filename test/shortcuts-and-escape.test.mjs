// Escape closes the settings dialog; the new-session control does NOT advertise a shortcut.
//
// MEASURED on a running replica (:10580), driving real key events:
//
//   baseline           hash ''                    body 3188 chars
//   opened settings    hash '#settings/general'    body 1525
//   after Escape       hash ''                    body 1212      <- Escape closed it
//
//   Ctrl+N             hash ''  unchanged, session count unchanged
//   Ctrl+,             hash ''  unchanged
//
// A keydown probe confirmed the events REACH the page:
//   [{"key":"n","code":"KeyN","ctrl":true,"meta":false,"target":"BODY"}]
// so the absence of a response is the app's behaviour, not a synthetic-event limitation.
//
// WHY Ctrl+N DOES NOTHING, and why that is correct: the main process installs a menu with
// exactly two accelerators (CmdOrCtrl+Shift+H and CmdOrCtrl+\), and the frontend binds no
// new-session hotkey of its own. The menu bar is hidden on purpose, mirroring the shipped shell.
//
// A FALSE ALARM worth recording. An earlier enumeration of the sidebar showed the string
// '新建 Ctrl + N' and I read it as the UI promising a shortcut. Inspecting the element showed
// the 新建 span has exactly one child and no sibling hint — the concatenated string came from
// innerText joining separate nodes. The UI never promised Ctrl+N.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the app menu defines exactly two accelerators, and no new-session hotkey', () => {
  // Measured from desktop/app-menu.cjs: only CmdOrCtrl+Shift+H and the backslash one are bound.
  // Compared by COUNT and by the absence of a new-session binding, so the assertion does not
  // depend on escaping a literal backslash.
  const menu = read('desktop/app-menu.cjs');
  const accels = [...menu.matchAll(/accelerator:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.equal(accels.length, 2, 'the accelerator count changed: ' + JSON.stringify(accels));
  assert.ok(accels.some((a) => a === 'CmdOrCtrl+Shift+H'), 'the zoom accelerator is gone: ' + JSON.stringify(accels));
  assert.ok(accels.some((a) => a.startsWith('CmdOrCtrl+') && a.endsWith(String.fromCharCode(92))),
    'the backslash accelerator is gone: ' + JSON.stringify(accels));
  assert.equal(accels.some((a) => /\+N$/i.test(a)), false, 'a new-session accelerator appeared');
});
test('the menu bar is hidden rather than removed', () => {
  // The shipped shell hides the bar but keeps the menu installed; removing it would also drop
  // the two accelerators that do work.
  const menu = read('desktop/app-menu.cjs');
  // Assert the real call, receiver included. Two traps found by mutation:
  //   1. `setMenuBarVisibility(false)` also appears in a COMMENT at line 5, so matching the
  //      bare call stayed green when the real argument was flipped;
  //   2. the real line is `win.setMenuBarVisibility(false);` — a regex anchored on the method
  //      name alone matches the comment instead.
  assert.match(menu, /win\.setMenuBarVisibility\(false\)\s*;/, 'the window no longer hides its menu bar');
  assert.match(menu, /setApplicationMenu/, 'the application menu is no longer installed');
});

test('the shipped frontend is what renders the sidebar controls', () => {
  // The reconstruction serves the shipped bundle; it does not re-implement the new-session
  // control, which is why there is no local handler to grep for.
  const protocol = read('desktop/app-protocol.cjs');
  assert.match(protocol, /function resolveFrontendRoot\(/, 'the frontend resolver is gone');
});