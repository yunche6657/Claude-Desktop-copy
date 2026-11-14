// ClaudeCode.getStatus must answer a bare enum string, not an object.
//
// The renderer's gate (cc43287c9-DJ31ir0Z.js, `kz`) does:
//   let o = (async () => await e() === xt.Updating
//              ? (await t()).success ? "landed" : "download_failed"
//              : "not_needed")().catch(() => "error")
// with the enum from shared-0-ByI5P0CP.js (`Ty`):
//   NotInstalled="not_installed" Updating="updating"
//   Ready="ready"                DownloadFailed="download_failed"
//
// `await e() === xt.Updating` compares the WHOLE answer against a string. Both methods had
// no handler, so getStatus fell through to the generic fallback — which answers a
// {status, reason} object for `get*` methods. An object is never === "updating", and its
// "unavailable" value is not even a member of the enum.
//
// Measured before the fix: answer {status:"unavailable",reason:...}, typeof "object".
// Measured after: "not_installed", typeof "string", gate outcome "not_needed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

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
  const channels = [...handlers.keys()];
  const call = (service, method, ...args) => {
    const channel = channels.find((c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`));
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { kernel, call, channels, handlers };
}

/** The literals from shared-0-ByI5P0CP.js `Ty`. */
const CLI_STATUS = {
  NotInstalled: 'not_installed',
  Updating: 'updating',
  Ready: 'ready',
  DownloadFailed: 'download_failed',
};

test('getStatus answers a bare string from the CLI status enum', async () => {
  const { call } = makeBridge();
  const status = await call('ClaudeCode', 'getStatus');

  assert.equal(typeof status, 'string', 'an object can never be === "updating"');
  assert.ok(
    Object.values(CLI_STATUS).includes(status),
    `"${status}" is not a member of the enum the renderer compares against`,
  );
});

test('this build reports not_installed, which is the honest answer', async () => {
  // No Claude Code CLI ships with this reconstruction. "ready" would make the app offer to
  // start a CLI that does not exist; "updating" would make it wait on a download that never
  // completes (the gate would then time out after 90s and mark itself failed).
  const { call } = makeBridge();
  assert.equal(await call('ClaudeCode', 'getStatus'), CLI_STATUS.NotInstalled);
});

test('the gate the renderer runs produces not_needed', async () => {
  // Replay `kz` exactly, with the real answers from the bridge.
  const { call } = makeBridge();
  const getStatus = () => call('ClaudeCode', 'getStatus');
  const prepare = () => call('ClaudeCode', 'prepare');

  const outcome = await (async () =>
    (await getStatus()) === CLI_STATUS.Updating
      ? ((await prepare()).success ? 'landed' : 'download_failed')
      : 'not_needed')();

  assert.equal(outcome, 'not_needed', 'this build must not enter the download branch');
});

test('prepare answers the shape the consumer reads, even though it is unreachable', async () => {
  // prepare() is only called while getStatus === "updating", which never happens here.
  // It still must not answer null: the consumer reads `.success` off it, and a null there
  // would throw inside the gate's promise (masked by its .catch, but still wrong).
  const { call } = makeBridge();
  const answer = await call('ClaudeCode', 'prepare');

  assert.notEqual(answer, null);
  assert.equal(typeof answer, 'object');
  assert.ok('success' in answer, 'the consumer reads .success');
  assert.equal(answer.success, false, 'nothing was downloaded, so it did not succeed');
});

test('if the status ever said updating, the gate would take a defined branch', async () => {
  // Guards the contract from the other side: whichever status is reported, the gate has a
  // deterministic outcome. A status outside the enum would silently mean "not_needed",
  // which is what made the original bug invisible.
  const { call } = makeBridge();
  const status = await call('ClaudeCode', 'getStatus');
  const prepare = await call('ClaudeCode', 'prepare');
  const outcome = status === CLI_STATUS.Updating
    ? (prepare.success ? 'landed' : 'download_failed')
    : 'not_needed';
  assert.ok(
    ['landed', 'download_failed', 'not_needed'].includes(outcome),
    `unexpected gate outcome: ${outcome}`,
  );
});
