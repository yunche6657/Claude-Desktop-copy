// The window-control global the shipped renderer calls must exist.
//
// The renderer opens Settings with
//
//   function Er(){ return window.electronWindowControl?.openSettingsWindow?.() }
//
// Measured on the replica: the global was absent, so Cmd/Ctrl+, did nothing at all.
// Optional chaining swallowed the missing method — no error, no navigation, and the
// shortcut row still advertised "设置 Ctrl + ,". The same global also backs the
// title-bar buttons and the Quick Entry windows.
//
// `claude.internal.ui` is not in the shipped bridge map, so the namespace loop in the
// preload never built it: the channels exist (main-services registers the service) but
// nothing exposed them to the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, 'desktop', name), 'utf8');

test('the frontend preload exposes electronWindowControl', () => {
  // This is the preload the frontend-mode window actually loads (main.cjs, useFrontend).
  const preload = read('preload-frontend.cjs');
  assert.match(preload, /expose\('electronWindowControl'/, 'the global the renderer calls is missing');
});

test('every window-control member the renderer uses is provided', () => {
  // Collected from the shipped bundle by scanning for electronWindowControl?.<member>.
  const REQUIRED = ['focus', 'getQuickEntryPayload', 'openQuickEntryWindow', 'openSettingsWindow',
    'setIncognitoMode', 'show', 'minimize', 'maximize', 'unmaximize', 'toggleMaximize', 'close',
    'getWindowState', 'onWindowStateChanged'];
  const preload = read('preload-frontend.cjs');
  const start = preload.indexOf("expose('electronWindowControl'");
  assert.ok(start > 0);
  const block = preload.slice(start, start + 2000);
  for (const member of REQUIRED) {
    assert.match(block, new RegExp('\\b' + member + '\\s*:'), 'missing member: ' + member);
  }
});

test('opening settings is handled in the main process', () => {
  const services = read('main-services.cjs');
  const at = services.indexOf('openSettingsWindow');
  assert.ok(at > 0, 'the openSettingsWindow handler is missing');
  const block = services.slice(at, at + 600);
  // A handler that only returns ok without routing the window does nothing visible.
  assert.match(block, /location\.hash|loadURL|navigate/, 'the handler must actually route the window');
});

test('the preload builds the internal channel the same way buildService does', () => {
  // claude.internal.ui is absent from bridge-map.json, so this namespace has to be
  // constructed by hand — and it must use the same message channel shape.
  const preload = read('preload-frontend.cjs');
  assert.match(preload, /messageChannel\('claude\.internal\.ui'/, 'the internal channel must use messageChannel()');
});
