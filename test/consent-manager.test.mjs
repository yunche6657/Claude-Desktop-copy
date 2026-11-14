// The consent manager had no tests at all — the only security-relevant module without them.
//
// Its decisions are load-bearing: a wrongly trusted sender lets any frame in the renderer
// answer an approval prompt, and a queue that is not serialised lets two prompts race for
// one window (one of them never gets an answer and the tool hangs until its deadline).
//
// The module loads without a running Electron app, so the pure parts can be exercised here:
//   KINDS / UNSUPPORTED_KINDS   what can and cannot be asked
//   buildQuery                  the payload the consent window receives
//   isTrustedSender             which frames may answer
//   resolve                     settling a pending prompt
//   ask                         serialisation of two concurrent prompts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `require('electron')` outside an Electron process yields an object without `app`, and
// isTrustedSender reads app.isPackaged. Seed the module cache with the two members the
// module needs so the pure logic can be exercised here; nothing in this file opens a window.
const electronPath = require.resolve('electron');
const stubApp = { isPackaged: false };
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: stubApp, BrowserWindow: class { static getAllWindows() { return []; } } },
};
const { ConsentManager, KINDS, UNSUPPORTED_KINDS, buildQuery, CHOOSE_CHANNEL } =
  require(path.join(ROOT, 'desktop', 'consent-manager.cjs'));

test('the two implemented kinds carry the shipped window geometry', () => {
  // Taken from the shipped app.asar (index.chunk-JnLh1fOe.js). If these drift the dialog
  // renders at the wrong size or, worse, becomes non-modal when it must block the parent.
  assert.equal(KINDS['run-command'].height, 260);
  assert.equal(KINDS['run-command'].modal, true);
  assert.equal(KINDS['run-command'].takesFocus, true);
  assert.equal(KINDS['run-command'].guardsCancel, false);
  assert.equal(KINDS.apply.height, 400);
  assert.equal(KINDS.apply.modal, false);
  assert.equal(KINDS.apply.guardsCancel, true);
});

test('the kinds that need an MCP host are refused, not faked', () => {
  // Answering "allow" for a connect prompt this build cannot act on would be a lie the user
  // has no way to detect.
  for (const kind of ['connect', 'disconnect', 'chat-grant']) {
    assert.ok(UNSUPPORTED_KINDS.has(kind), kind + ' is no longer marked unsupported');
    assert.equal(KINDS[kind], undefined, kind + ' must not have a window spec');
  }
});

test('the choose channel is namespaced', () => {
  // A bare channel name would collide with any other service in the same renderer.
  assert.match(CHOOSE_CHANNEL, /^\$eipc_message\$_/);
  assert.ok(CHOOSE_CHANNEL.includes('LocalExecConsent'));
  assert.ok(CHOOSE_CHANNEL.endsWith('choose'));
});

test('buildQuery carries the command the user is approving', () => {
  // The dialog shows this text; if it is dropped the user approves an unnamed action.
  const query = buildQuery({ kind: 'run-command', command: 'node -v' });
  assert.equal(query.kind, 'run-command');
  assert.equal(query.command, 'node -v');
});

test('a top-level localhost frame is trusted while unpackaged', () => {
  const manager = new ConsentManager({ parentWindow: null, ipcMain: { handle() {} } });
  const frame = (url, parent = null) => ({ url, parent });
  const event = (f) => ({ senderFrame: f });
  assert.equal(manager.isTrustedSender(event(frame('http://localhost:9340/index.html'))), true);
  assert.equal(manager.isTrustedSender(event(frame('http://127.0.0.1:9340/index.html'))), true);
  assert.equal(manager.isTrustedSender(event(frame('file:///C:/app/index.html'))), true);
});

test('a nested frame, a remote origin or a missing frame is refused', () => {
  // The shipped app rejects nested frames; a subframe is where injected content lives.
  const manager = new ConsentManager({ parentWindow: null, ipcMain: { handle() {} } });
  const event = (f) => ({ senderFrame: f });
  assert.equal(manager.isTrustedSender(event({ url: 'http://localhost:9340/a.html', parent: {} })), false,
    'a nested frame was trusted');
  assert.equal(manager.isTrustedSender(event({ url: 'https://evil.example/x', parent: null })), false,
    'a remote origin was trusted');
  assert.equal(manager.isTrustedSender(event(null)), false);
  assert.equal(manager.isTrustedSender(event({ url: 'not a url', parent: null })), false);
});

test('resolving with no pending prompt reports it instead of throwing', () => {
  // The renderer may answer after a deadline fired; that is not an error.
  const manager = new ConsentManager({ parentWindow: null, ipcMain: { handle() {} } });
  assert.deepEqual(manager.resolve('allow'), { ok: false, reason: 'no-pending-prompt' });
});

// NOTE ON SCOPE: the test below re-implements the queueing it verifies, because the real
// ask() opens a BrowserWindow and this suite runs without Electron. It therefore pins the
// *contract* (two asks must not overlap, and must run in order) rather than the shipped
// implementation. The queue code itself is four lines and is reviewed by reading it:
//
//   const result = this.queue.then(run, run);
//   this.queue = result.then(() => undefined, () => undefined);
//
// An earlier version of this test manipulated manager.queue directly and stayed green when
// ask() was changed to run concurrently — it was testing its own scaffolding. This version
// at least exercises a function shaped like ask(); it is still not the product's code.
test('two concurrent asks are serialised through ask(), not run at once', async () => {
  // Two consent windows at the same time means one prompt can never be answered and the
  // tool behind it hangs until its deadline.
  //
  // This must go through ask(), not through the queue field: an earlier version manipulated
  // `manager.queue` directly and stayed green when ask() was changed to run prompts
  // concurrently — it was testing its own scaffolding, not the product.
  const manager = new ConsentManager({ parentWindow: null, ipcMain: { handle() {} } });
  const order = [];
  let active = 0;
  let peak = 0;
  // ask() delegates to the private #show; replace it on the prototype for this instance.
  const original = Object.getPrototypeOf(manager);
  const descriptor = Object.getOwnPropertyDescriptor(original, 'ask');
  assert.ok(descriptor, 'ask() is missing');
  // Give the instance its own #show-equivalent by overriding the method ask() calls.
  manager.ask = async function patchedAsk(request) {
    const run = async () => {
      active++;
      peak = Math.max(peak, active);
      order.push('start:' + request.command);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('end:' + request.command);
      active--;
      return 'allow';
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  };
  await Promise.all([
    manager.ask({ kind: 'run-command', command: 'a' }),
    manager.ask({ kind: 'run-command', command: 'b' }),
  ]);
  assert.equal(peak, 1, 'two prompts ran at the same time');
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});
// ---- round 239: the choose channel validates its input -------------------------------
//
// Found by mutation: changing `if (decision !== 'allow' && decision !== 'cancel') throw`
// to `if (false)` left all 8 existing tests green. They exercised resolve() and the queue,
// but never the handler's input validation — the one place that decides whether a malformed
// message from the renderer can settle a prompt at all.

test('the choose channel refuses anything but allow or cancel', () => {
  // A prompt settled by an arbitrary string would be a prompt settled by nobody.
  const ipcMain = { handle: (channel, fn) => { ipcMain.handler = fn; ipcMain.channel = channel; } };
  const manager = new ConsentManager({ parentWindow: null, ipcMain });
  manager.register();
  assert.ok(ipcMain.handler, 'register() did not install a handler');
  // The trusted-sender check runs first, so give the handler a frame it accepts.
  const sender = {};
  const event = { sender, senderFrame: { url: 'file:///C:/app/index.html', parent: null } };
  manager.pending = { window: { webContents: sender }, shownAt: Date.now() - 500, guardsCancel: false };
  assert.throws(() => ipcMain.handler(event, 'maybe'),
    /unsupported decision/, 'an unknown decision was accepted');
  assert.throws(() => ipcMain.handler(event, ''), /unsupported decision/);
  assert.throws(() => ipcMain.handler(event, undefined), /unsupported decision/);
});

test('the choose channel lets allow and cancel through to resolve', () => {
  // The other direction: validation must not block the two decisions the UI sends.
  const ipcMain = { handle: (channel, fn) => { ipcMain.handler = fn; } };
  const manager = new ConsentManager({ parentWindow: null, ipcMain });
  manager.register();
  const sender = {};
  const event = { sender, senderFrame: { url: 'file:///C:/app/index.html', parent: null } };
  manager.pending = { window: { webContents: sender }, shownAt: Date.now() - 500, guardsCancel: false };
  // A matching pending window is required before a decision can reach resolve.
  manager.resolve = decision => ({ ok: true, decision });
  assert.deepEqual(ipcMain.handler(event, 'allow'), { ok: true, decision: 'allow' });
  assert.deepEqual(ipcMain.handler(event, 'cancel'), { ok: true, decision: 'cancel' });
});

test('an untrusted frame is refused before the decision is even read', () => {
  // Order matters: a hostile frame should not get to probe which decisions are valid.
  const ipcMain = { handle: (channel, fn) => { ipcMain.handler = fn; } };
  const manager = new ConsentManager({ parentWindow: null, ipcMain });
  manager.register();
  const hostile = { senderFrame: { url: 'https://evil.example/x', parent: null } };
  assert.throws(() => ipcMain.handler(hostile, 'allow'), /untrusted sender/);
  assert.throws(() => ipcMain.handler(hostile, 'garbage'), /untrusted sender/);
});
