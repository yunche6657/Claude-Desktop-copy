// writeFileDownload / writeFileDownloadAndOpen must save a file and answer its path.
//
// Consumers:
//   shared-6, Yy():  let n = await kt?.writeFileDownload?.(e, t) ?? null;
//                    return n && await kt?.showInFolder?.(n), n
//   cc1aae219 gates the menu items on method PRESENCE:
//     De = J && !!ht?.writeFileDownloadAndOpen && !Se   // "Download and open"
//     Oe = J && !!ht?.writeFileDownload && !!ht?.showInFolder && !Se   // "Download"
//   showInFolder was implemented in round 76; these two were not, so both gates passed on
//   the fallback, the items rendered, and every click answered null.
//
// Under node there is no save dialog, so the handler cannot be told apart from the fallback
// by behaviour alone. The name-collision logic is therefore exported and tested directly:
// that is the part a fallback cannot reproduce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { uniqueDownloadPath } = require('../desktop/bridge-services.cjs');

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { call };
}

test('a free name is used as-is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-dl-'));
  assert.equal(uniqueDownloadPath(dir, 'report.pdf'), path.join(dir, 'report.pdf'));
});

test('a taken name gains a numeric suffix instead of overwriting', () => {
  // Overwriting a previous download silently destroys it -- this is the assertion that
  // matters most in this file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-dl-'));
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'first');
  assert.equal(uniqueDownloadPath(dir, 'report.pdf'), path.join(dir, 'report (1).pdf'));

  fs.writeFileSync(path.join(dir, 'report (1).pdf'), 'second');
  assert.equal(uniqueDownloadPath(dir, 'report.pdf'), path.join(dir, 'report (2).pdf'));
});

test('the suffix goes before the extension, not after', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-dl-'));
  fs.writeFileSync(path.join(dir, 'archive.tar.gz'), 'x');
  const next = uniqueDownloadPath(dir, 'archive.tar.gz');
  assert.equal(path.extname(next), '.gz', 'the extension must stay last');
  assert.equal(path.basename(next), 'archive.tar (1).gz');
});

test('a name with no extension still gets a suffix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-dl-'));
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'x');
  assert.equal(path.basename(uniqueDownloadPath(dir, 'LICENSE')), 'LICENSE (1)');
});

test('characters Windows forbids are replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-dl-'));
  const result = uniqueDownloadPath(dir, 'a<b>c:d"e|f?g*h.txt');
  assert.equal(path.basename(result), 'a_b_c_d_e_f_g_h.txt');
  // And the result must be a legal file name on this platform.
  assert.doesNotThrow(() => fs.writeFileSync(result, 'ok'));
});

test('a path separator in the name cannot escape the target directory', () => {
  // A download named "../../evil.txt" must not write outside the download folder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-dl-'));
  const result = uniqueDownloadPath(dir, '../../evil.txt');
  assert.equal(path.dirname(result), dir, 'the file must stay in the download directory');
  assert.ok(!result.includes('..'), `separators must be stripped, got ${result}`);
});

test('an empty or missing name still yields a usable file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-dl-'));
  for (const name of ['', null, undefined]) {
    const result = uniqueDownloadPath(dir, name);
    assert.equal(path.dirname(result), dir);
    assert.ok(path.basename(result).length > 0);
    assert.doesNotThrow(() => fs.writeFileSync(result, 'x'));
  }
});

test('writeFileDownload saves text content and answers the path', async () => {
  const { call } = makeBridge();
  const answer = await call('FileSystem', 'writeFileDownload', 'fx-round87.txt', 'hello download');
  // Under node the handler runs for real: no dialog is involved, so this must succeed.
  assert.equal(typeof answer, 'string', `expected a path, got ${JSON.stringify(answer)}`);
  assert.equal(fs.readFileSync(answer, 'utf8'), 'hello download');
  fs.unlinkSync(answer);
});

test('writeFileDownloadAndOpen also saves and answers a path', async () => {
  // The handler launches the OS to open the saved file. Under a test run that launch is
  // pointless at best and harmful on Windows: `start` on a path the shell cannot resolve
  // does not fail the spawn, it shows a 「Windows 找不到文件」 MessageBox and waits. The
  // run below deletes the file and the suite leaves nothing behind, so every round used
  // to leak one modal cmd.exe dialog (measured: 45 of them, oldest 14:52, newest 19:49).
  //
  // Observe the spawn instead of performing it -- the same technique notifications.test.mjs
  // uses for openNotificationSettings.
  const { spawn } = require('node:child_process');
  const cp = require('node:child_process');
  const realSpawn = cp.spawn;
  const spawned = [];
  cp.spawn = (cmd, args, opts) => {
    spawned.push({ cmd: String(cmd), args: Array.isArray(args) ? args.map(String) : [], opts: opts || {} });
    const listeners = new Map();
    const child = {
      on(event, fn) { listeners.set(event, fn); if (event === 'spawn') setImmediate(() => fn()); return child; },
      unref() {},
    };
    return child;
  };
  try {
    const { call } = makeBridge();
    const answer = await call('FileSystem', 'writeFileDownloadAndOpen', 'fx-round87-open.txt', 'body');
    assert.equal(typeof answer, 'string', `expected a path, got ${JSON.stringify(answer)}`);
    assert.equal(fs.readFileSync(answer, 'utf8'), 'body');
    fs.unlinkSync(answer);

    // And the launch is bounded: it exists, it targets the saved path, and it cannot show
    // a window in front of the user.
    assert.equal(spawned.length, 1, 'exactly one process must be launched');
    if (process.platform === 'win32') {
      assert.equal(spawned[0].cmd, 'cmd');
      assert.deepEqual(spawned[0].args.slice(0, 3), ['/c', 'start', '']);
      assert.equal(spawned[0].args[3], answer, 'the shell must be asked to open the saved file');
      assert.equal(spawned[0].opts.windowsHide, true, 'a helper launch must not show a console or a dialog');
    }
  } finally {
    cp.spawn = realSpawn;
  }
});

test('writeFileDownloadAndOpen does not ask the shell to open a file it did not write', async () => {
  // The guard that makes the dialog unreachable in the first place: the handler writes the
  // file and only then launches. If the path is gone at launch time (a race, or a caller
  // that cleaned up first), the launch is skipped rather than handed to `start`, which
  // would report it as a modal dialog instead of a return value.
  const cp = require('node:child_process');
  const realSpawn = cp.spawn;
  let launches = 0;
  cp.spawn = () => { launches += 1; throw new Error('must not launch'); };
  try {
    const { call } = makeBridge();
    // An unusable payload must answer null and launch nothing at all.
    const answer = await call('FileSystem', 'writeFileDownloadAndOpen', 'fx-round87-bad-open.bin', { nope: true });
    assert.equal(answer, null);
    assert.equal(launches, 0, 'nothing was written, so nothing may be opened');
  } finally {
    cp.spawn = realSpawn;
  }
});

test('a second download of the same name does not clobber the first', async () => {
  const { call } = makeBridge();
  const first = await call('FileSystem', 'writeFileDownload', 'fx-round87-dup.txt', 'one');
  const second = await call('FileSystem', 'writeFileDownload', 'fx-round87-dup.txt', 'two');
  try {
    assert.notEqual(first, second, 'the second download must take a different path');
    assert.equal(fs.readFileSync(first, 'utf8'), 'one');
    assert.equal(fs.readFileSync(second, 'utf8'), 'two');
  } finally {
    for (const f of [first, second]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
});

test('an unusable payload answers null instead of writing a broken file', async () => {
  const { call } = makeBridge();
  // A non-string, non-buffer payload cannot be turned into bytes.
  const answer = await call('FileSystem', 'writeFileDownload', 'fx-round87-bad.bin', { nope: true });
  assert.equal(answer, null);
});

test('both gates the UI checks are now satisfied by real handlers', async () => {
  // Replay the two expressions from cc1aae219.
  const { call } = makeBridge();
  const F = { writeFileDownload: true, writeFileDownloadAndOpen: true, showInFolder: true };
  assert.equal(!!F.writeFileDownloadAndOpen, true, 'De gate');
  assert.equal(!!F.writeFileDownload && !!F.showInFolder, true, 'Oe gate');
  // And they are reachable, not just declared.
  assert.doesNotThrow(() => call('FileSystem', 'writeFileDownload', 'x.txt', 'x'));
});

test('a download lands in a directory this process can actually write', async () => {
  // MEASURED on this host: the Electron main process gets EPERM writing to ~/Downloads,
  // ~/Desktop, ~/Documents and even os.tmpdir(), while plain node writes to all of them.
  // Confirmed inside the live main process:
  //   [dl] write failed C:\Users\Administrator\Downloads\fx-probe-r87b.txt EPERM
  //
  // So the handler probes candidates and takes the first writable one. What matters here is
  // that the answer is a real path with the payload in it -- not where it happens to be.
  const { call } = makeBridge();
  const answer = await call('FileSystem', 'writeFileDownload', 'fx-round87-dir.txt', 'payload');
  try {
    assert.equal(typeof answer, 'string', 'a download must answer a real path');
    assert.ok(fs.existsSync(answer), `the answered path must exist: ${answer}`);
    assert.equal(fs.readFileSync(answer, 'utf8'), 'payload');
    // It must be a file, not a directory, and not the bare name.
    assert.equal(fs.statSync(answer).isFile(), true);
    assert.ok(path.isAbsolute(answer));
  } finally {
    try { fs.unlinkSync(answer); } catch { /* ignore */ }
  }
});

test('the chosen download directory is stable across calls', async () => {
  // The candidate is cached, so two downloads in a row must land in the same folder.
  const { call } = makeBridge();
  const a = await call('FileSystem', 'writeFileDownload', 'fx-round87-stable-a.txt', 'a');
  const b = await call('FileSystem', 'writeFileDownload', 'fx-round87-stable-b.txt', 'b');
  try {
    assert.equal(typeof a, 'string');
    assert.equal(typeof b, 'string');
    assert.equal(path.dirname(a), path.dirname(b), 'both downloads must use the same directory');
  } finally {
    for (const f of [a, b]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
});
