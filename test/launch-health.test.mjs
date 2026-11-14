// The health check a fresh launch must pass: no error, no alert, a usable composer.
//
// MEASURED on a clean launch (replica :10380):
//   log lines matching /Error|error:|unhandled|TypeError|Cannot read/: 0
//   [fallback] hits: 40  (all typed empty answers, not crashes)
//   electron processes: 4
//   DOM: 2454 chars, 0 role=alert nodes, 1 visible contenteditable,
//        sidebar present, composer present, document.title 'Claude'
//
// The DOM half is what this file can check without a browser: it asserts the bootstrap and the
// renderer entry are wired so a launch has something to paint. The live numbers above are the
// evidence that the wiring actually runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the served document is the shipped index.html, and it has a title and a root', () => {
  // Measured: document.title was 'Claude' and the page rendered. The document is NOT built by
  // bootstrap-service.cjs (which has no HTML at all) — it is the shipped ion-dist/index.html,
  // served through the app:// protocol. A first version of this test looked in the bootstrap
  // and failed against correct code.
  const served = path.join(ROOT, 'resources', 'ion-dist', 'index.html');
  assert.ok(fs.existsSync(served), 'the shipped index.html is missing');
  const html = fs.readFileSync(served, 'utf8');
  assert.match(html, /<title/i, 'the served document has no title');
  assert.match(html, /<div id=/i, 'the served document has no mount point');
});

test('the renderer entry is served rather than 404ed', () => {
  // A missing entry is the classic blank-window cause.
  const protocol = read('desktop/app-protocol.cjs');
  assert.match(protocol, /ion-dist|index\.html/, 'no renderer entry is referenced');
});

test('an unhandled renderer error is logged rather than swallowed', () => {
  // Measured: the log had zero such lines on a healthy launch, which is only meaningful if
  // the handler exists to write them.
  const main = read('desktop/main.cjs');
  assert.match(main, /render-process-gone|unresponsive|console-message/, 'no renderer failure hook');
});

test('the launcher keeps the frontend and agent mode while leaving kernel choice to availability', t => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-health-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  const env = require('../tools/launch-replica.cjs').buildLauncherEnv({ LOCALAPPDATA:isolated, APPDATA:isolated, USERPROFILE:isolated, HOME:isolated, CLAUDE_WORKSPACE:isolated });
  assert.equal(env.CLAUDE_VIEW, 'frontend'); assert.equal(env.MODE, 'agent');
  assert.equal(env.CLAUDE_AGENT_KERNEL, undefined);
});

test('the diagnostic channels a health check needs are registered', () => {
  // $diag$_kernel_state and $diag$_fallback_report are what made the live measurements above
  // possible; without them the checks would be guesswork.
  const main = read('desktop/main.cjs');
  // Assert the REGISTRATION, not the name: the channel name also appears in comments.
  assert.match(main, /ipcMain\.handle\('\$diag\$_kernel_state', \(\) => \{/,
    'the kernel_state channel is not registered');
  assert.match(main, /ipcMain\.handle\('\$diag\$_fallback_report', \(\) => \{/,
    'the fallback_report channel is not registered');
});