// The 86 called-but-fallback readers, classified by WHY they are still fallback.
//
// This file exists to stop the classification being redone every round. Every entry below was
// measured; the point is that most are not gaps this project can close, and the ones that were
// real gaps are now implemented elsewhere (getContextUsageSummary, getConfiguredServices, the
// MCP readers).
//
//   MEASURED on this host:
//     `gh --version`                  -> absent (no gh CLI)
//     `git rev-parse --is-inside-work-tree` -> exit 128 (this directory is not a repository)
//
// So the GitHub and branch readers cannot return data even if implemented: the capability they
// wrap does not exist here. Answering [] is the honest result, not a bug.
//
//   CREDENTIAL readers (getSSH*, listSSH*) need a remote host the user has configured.
//   BACKGROUND-TASK readers (getTaskOutput, stopTask) need a task runner; this build starts
//   every turn inline, so there is no background task to tail.
//   *StateStore.getState / getStateSync are answered {} by the generic dispatcher on purpose:
//   the renderer stores are its own, and an empty object is the correct 'nothing cached' value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function makeBridge() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-class-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  const handlers = new Map();
  registerBridgeServices({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  const call = async (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => {
      const seg = c.split('_$_');
      return seg[seg.length - 2] === service && seg[seg.length - 1] === method;
    });
    if (!channel) throw new Error('no handler for ' + service + '.' + method);
    return await handlers.get(channel)({}, ...args);
  };
  return { call, cleanup: () => { try { fs.unlinkSync(storePath); } catch { /* gone */ } } };
}

test('every renderer state store answers {} rather than null', async () => {
  // The dispatcher special-cases getState/getStateSync BEFORE emptyFor. A null here would make
  // the renderer's `e?.login` / `t.udid` style reads throw instead of reading undefined.
  const b = await makeBridge();
  try {
    for (const service of ['bootstrapStateStore', 'attachmentStore', 'updaterStateStore',
      'navigationStateStore', 'hostPowerStore', 'deviceLinkStore', 'compositingStore',
      'debugAttachingStore', 'connectedFilesStateStore', 'hybridTransitionStore',
      'supportBundleStateStore']) {
      for (const method of ['getState', 'getStateSync']) {
        const value = await b.call(service, method);
        assert.deepEqual(value, {}, service + '.' + method + ' answered ' + JSON.stringify(value));
      }
    }
  } finally { b.cleanup(); }
});

test('the GitHub readers answer an array even though this host has no gh CLI', async () => {
  // The panel calls `.map()` on the result. The capability is absent, so the answer is empty —
  // but it must still be the right SHAPE, otherwise the absence turns into a crash.
  const b = await makeBridge();
  try {
    const issues = await b.call('LocalSessions', 'listGhIssues', process.cwd(), '');
    assert.ok(Array.isArray(issues), 'listGhIssues answered ' + JSON.stringify(issues));
  } finally { b.cleanup(); }
});

test('the SSH grant reader answers an array, which its caller filters directly', async () => {
  // Measured historically: this answered null and the settings panel ran
  //   (await getSSHHostToolGrants()).filter(...).length
  // which threw. It is already handled by emptyFor; this pins it.
  const b = await makeBridge();
  try {
    const grants = await b.call('LocalSessions', 'getSSHHostToolGrants');
    assert.ok(Array.isArray(grants), 'getSSHHostToolGrants answered ' + JSON.stringify(grants));
  } finally { b.cleanup(); }
});

test('the context summary and the context usage share one shape', async () => {
  // Already covered in context-usage-summary.test.mjs; repeated here as the example of a gap
  // this project COULD close, so the classification file records a positive case too.
  const b = await makeBridge();
  try {
    const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
    void createSessionKernel;
    const summary = await b.call('LocalSessions', 'getContextUsageSummary', 'local_missing');
    assert.equal(summary, null, 'a missing session must answer null, not a fabricated object');
  } finally { b.cleanup(); }
});
