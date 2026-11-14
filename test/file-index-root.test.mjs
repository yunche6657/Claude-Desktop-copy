// The file index behind @-mentions used to resolve its root from
//   settings.focusedCwd || kernel.getAll()[0].cwd || process.cwd()
// but `focusedCwd` was never assigned anywhere, so it silently indexed the FIRST
// session ever created rather than the open one.
//
// In this workspace that meant 20389 paths from the PARENT folder (ccd-ref/,
// qq_tools/, …) and none of the open project's own files. The renderer does tell the
// bridge which session is on screen — `setFocusedSession(sessionId)` on focus and
// `setFocusedSession(null)` on blur — but nothing implemented it.
//
// NOTE: every bridge handler is async (ipcMain.handle), so these tests must await.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function stubAgent() {
  return {
    model: 'stub-model',
    tools: [],
    async run({ onEvent }) {
      onEvent({ type: 'text', text: 'OK' });
      return { text: 'OK', stopReason: 'end_turn' };
    },
  };
}

/** A real bridge over stubbed Electron plumbing, so the handlers are the shipped ones. */
function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({ emit: () => {}, createAgent: () => stubAgent() });
  // The bridge builds its own kernel from `settings.kernelFactory`; without this it
  // holds `null` and cannot resolve a focused session's folder.
  const settings = {
    sidebarMode: 'epitaxy',
    themeMode: 'system',
    kernelFactory: () => kernel,
  };
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
    settings,
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  // Same handler, but the caller supplies the event slot itself. Needed to test the
  // (event, version) calling convention without the helper inserting an extra `{}`.
  const callRaw = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)(...args);
  };
  return { kernel, call, callRaw, settings };
}

/** Two throwaway folders, each with a file that identifies it. */
function makeTwoProjects() {
  const base = mkdtempSync(join(tmpdir(), 'fileindex-'));
  const first = join(base, 'first-project');
  const second = join(base, 'second-project');
  const { mkdirSync } = require('node:fs');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(join(first, 'only-in-first.txt'), 'a');
  writeFileSync(join(second, 'only-in-second.txt'), 'b');
  return {
    first,
    second,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test('setFocusedSession exists in both namespaces that declare it', async () => {
  // bridge-map declares it under LocalSessions and LocalAgentModeSessions, and the
  // renderer calls whichever surface it holds. A missing handler answered null and
  // the information was dropped.
  const { call } = makeBridge();
  for (const ns of ['LocalSessions', 'LocalAgentModeSessions']) {
    const res = await call(ns, 'setFocusedSession', null);
    assert.equal(res && res.ok, true, `${ns}.setFocusedSession must answer {ok:true}`);
  }
});

test('the file index follows the FOCUSED session, not the first one created', async () => {
  // This is the defect: the second session's folder is the one that must be indexed
  // once it is focused.
  const { kernel, call } = makeBridge();
  const projects = makeTwoProjects();
  try {
    kernel.start({ cwd: projects.first });
    const second = kernel.start({ cwd: projects.second });

    await call('LocalSessions', 'setFocusedSession', second.sessionId);
    const res = await call('Resources', 'getProjectFileListIfChanged', undefined);
    const paths = typeof res.paths === 'string' ? res.paths.split('\n') : [];

    assert.ok(
      paths.includes('only-in-second.txt'),
      `focused folder must be indexed; got ${JSON.stringify(paths.slice(0, 5))}`
    );
    assert.equal(
      paths.includes('only-in-first.txt'),
      false,
      'the unfocused session folder must not leak into the list'
    );
    assert.ok(
      res.version.startsWith(projects.second + ':'),
      'version must name the focused folder so a caller can tell them apart'
    );
  } finally {
    projects.cleanup();
  }
});

test('switching focus re-indexes the other project', async () => {
  const { kernel, call } = makeBridge();
  const projects = makeTwoProjects();
  try {
    const first = kernel.start({ cwd: projects.first });
    kernel.start({ cwd: projects.second });

    await call('LocalSessions', 'setFocusedSession', first.sessionId);
    const res = await call('Resources', 'getProjectFileListIfChanged', undefined);
    const paths = typeof res.paths === 'string' ? res.paths.split('\n') : [];

    assert.ok(paths.includes('only-in-first.txt'), 'focus change must re-index');
    assert.equal(paths.includes('only-in-second.txt'), false);
  } finally {
    projects.cleanup();
  }
});

test('blurring clears the focus without inventing a folder', async () => {
  // setFocusedSession(null) is what the renderer sends on blur. It must forget the
  // session rather than keep serving the last one as if still focused.
  const { kernel, call } = makeBridge();
  const projects = makeTwoProjects();
  try {
    const s = kernel.start({ cwd: projects.second });
    await call('LocalSessions', 'setFocusedSession', s.sessionId);
    const focused = await call('LocalSessions', 'setFocusedSession', null);
    assert.equal(focused.ok, true);
    assert.equal(focused.sessionId, null);
    assert.equal(focused.cwd, null, 'no folder must be implied after a blur');
  } finally {
    projects.cleanup();
  }
});

test('an unchanged version answers paths:null, so the caller can skip re-indexing', async () => {
  // The renderer calls this with ONE argument: `return t => e(t)` then `await e(r)`.
  // Every handler here takes the EIPC event first, so a single argument used to land
  // in the event slot and the version was never seen — the fast path never fired.
  //
  // This must use callRaw: the `call` helper inserts its own event object, which
  // would hide the single-argument case entirely.
  const { kernel, call, callRaw } = makeBridge();
  const projects = makeTwoProjects();
  try {
    const s = kernel.start({ cwd: projects.second });
    await call('LocalSessions', 'setFocusedSession', s.sessionId);

    const first = await call('Resources', 'getProjectFileListIfChanged', undefined);
    assert.equal(typeof first.paths, 'string', 'first call must return the list');

    // TRUE single-argument call, exactly like `e(t)` in the renderer.
    const second = await callRaw('Resources', 'getProjectFileListIfChanged', first.version);
    assert.equal(second.paths, null, 'unchanged version must skip the payload');
    assert.equal(second.version, first.version);
  } finally {
    projects.cleanup();
  }
});

test('the event-first shape still reaches the fast path', async () => {
  // Accepting both shapes must not break the bridge's own convention: a caller that
  // passes (event, version) must still get paths:null.
  const { kernel, call, callRaw } = makeBridge();
  const projects = makeTwoProjects();
  try {
    const s = kernel.start({ cwd: projects.second });
    await call('LocalSessions', 'setFocusedSession', s.sessionId);
    const first = await call('Resources', 'getProjectFileListIfChanged', undefined);
    assert.equal(typeof first.paths, 'string');
    const second = await callRaw('Resources', 'getProjectFileListIfChanged', { sender: 'x' }, first.version);
    assert.equal(second.paths, null, 'the event-first form must reach the fast path too');
  } finally {
    projects.cleanup();
  }
});
