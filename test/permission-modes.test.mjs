// The permission-mode set must contain every mode the shipped UI actually sends.
//
// "auto" was missing. It is a REAL mode, handled explicitly in the frontend:
//
//   c058fad4e-C-AvRBJf.js:  F = e => e === "auto" || e === "bypassPermissions" ? e : void 0
//   c0fd2fda3-CQ1-2UEl.js:  e === "auto" || e === "bypassPermissions" ? H(...) : e
//
// and the composer labels it "Auto — Recommended. Claude handles permissions".
// With it absent from VALID_MODES, 27 session records on disk looked illegal and
// setPermissionMode("auto") refused a mode the UI offers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MODES, VALID_MODES, decide, assertMode, ACTIONS } = require('../desktop/permissions.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

test('every mode the protocol can carry is valid', async () => {
  // Named explicitly so removing one fails here rather than in the UI.
  //
  // This is the shipped enum (shared-0-ByI5P0CP.js `Wy`), which is the protocol's
  // vocabulary — NOT this build's picker list. The picker shows five items; the enum
  // carries six plus the bridge's historical `ask`. An earlier version of this test
  // used a hand-written subset that happened to omit `dontAsk`, so it passed while the
  // bridge refused a value the protocol defines.
  for (const mode of ['ask', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'default', 'dontAsk']) {
    assert.ok(VALID_MODES.has(mode), `${mode} must be accepted`);
  }
});

test('dontAsk is a protocol value even though this build never offers it', async () => {
  // Two separate facts, and conflating them is what made the earlier round miss this:
  //
  //   1. `dontAsk` IS in the shipped enum (shared-0-ByI5P0CP.js, `Wy`):
  //        { Default:"default", AcceptEdits:"acceptEdits", Plan:"plan",
  //          Bypass:"bypassPermissions", DontAsk:"dontAsk", Auto:"auto" }
  //      and it has a picker label + description in shared-8-PHXy9B6B.js:
  //        label: "Don't ask"
  //        description: "Deny actions that aren't pre-approved, without prompting"
  //
  //   2. The picker of THIS build never lists it. The menu is built from
  //        TL = { local:["default","acceptEdits","plan"], remote:[...],
  //               bridge:[...], cowork:[...], hub:[...] }
  //        EL(e,t) = [...TL[e]] + (t.auto ? "auto" : []) + (t.bypass ? "bypassPermissions" : [])
  //      and `dontAsk` appears in none of those lists. Verified in the UI: the menu
  //      showed Auto / Manual / Accept edits / Plan / Bypass permissions — five items.
  //
  // So it must be ACCEPTED (an old record or another surface may carry it) without
  // claiming the picker shows it.
  assert.equal(MODES.DONT_ASK, 'dontAsk');
  assert.ok(VALID_MODES.has('dontAsk'));
  assert.equal(assertMode('dontAsk'), 'dontAsk');
});

test('dontAsk requires approval for changes and never allows them unattended', async () => {
  // The flag means "not pre-approved, so it cannot run on its own" — NOT "show a dialog".
  // tool-approval.cjs reads it as: prompt:false -> run immediately; prompt:true -> ask.
  //
  // An earlier version of this test asserted prompt:true while quoting "without prompting"
  // as its justification: the assertion and its own rationale contradicted each other, and
  // nothing caught it because both were written together. The value was right; the wording
  // was wrong. Correcting the wording by flipping the value would have been a security
  // regression, which is what the last assertion below now guards.
  assert.equal(decide(MODES.DONT_ASK, ACTIONS.EDIT).prompt, true);
  assert.equal(decide(MODES.DONT_ASK, ACTIONS.EXEC).prompt, true);
  assert.match(decide(MODES.DONT_ASK, ACTIONS.EDIT).reason, /never prompts/i);
  // Reads must stay free: denying them would break every tool call for no reason the
  // user asked for.
  assert.equal(decide(MODES.DONT_ASK, ACTIONS.READ).prompt, false);

  // dontAsk must never look like a blanket allow. If these ever become equal, dontAsk has
  // silently turned into bypassPermissions and edits run with no approval at all.
  for (const action of [ACTIONS.EDIT, ACTIONS.EXEC]) {
    assert.notEqual(
      decide(MODES.DONT_ASK, action).prompt,
      decide(MODES.BYPASS, action).prompt,
      'dontAsk collapsed into bypassPermissions for ' + action,
    );
  }
});

test('assertMode accepts auto and default', async () => {
  assert.equal(assertMode('auto'), 'auto');
  assert.equal(assertMode('default'), 'default');
});

test('every valid mode has a defined policy for every action', async () => {
  // A mode in the set but missing from decide()'s switch would return undefined and
  // crash the caller that reads .prompt.
  for (const mode of VALID_MODES) {
    for (const action of Object.values(ACTIONS)) {
      const policy = decide(mode, action);
      assert.ok(policy, `${mode}/${action} has no policy`);
      assert.equal(typeof policy.prompt, 'boolean', `${mode}/${action}`);
      assert.equal(typeof policy.reason, 'string', `${mode}/${action}`);
    }
  }
});

test('auto applies edits but still confirms commands', async () => {
  // The conservative reading of "Claude handles permissions": an unattended shell
  // command is the one thing a user cannot undo.
  assert.equal(decide(MODES.AUTO, ACTIONS.READ).prompt, false);
  assert.equal(decide(MODES.AUTO, ACTIONS.EDIT).prompt, false);
  assert.equal(decide(MODES.AUTO, ACTIONS.EXEC).prompt, true);
});

test('auto is not a blanket bypass', async () => {
  const autoPrompts = decide(MODES.AUTO, ACTIONS.EXEC).prompt;
  const bypassPrompts = decide(MODES.BYPASS, ACTIONS.EXEC).prompt;
  assert.equal(bypassPrompts, false);
  assert.notEqual(autoPrompts, bypassPrompts, 'auto must be stricter than bypass');
});

test('default resolves to the safe end of the range', async () => {
  assert.equal(decide(MODES.DEFAULT, ACTIONS.EXEC).prompt, true);
  assert.equal(decide(MODES.DEFAULT, ACTIONS.READ).prompt, false);
});

test('plan mode still never mutates', async () => {
  assert.equal(decide(MODES.PLAN, ACTIONS.EDIT).prompt, true);
  assert.equal(decide(MODES.PLAN, ACTIONS.EXEC).prompt, true);
});

test('a bridge session downgrades bypass to acceptEdits', async () => {
  // Observed in the shipped app: a blanket bypass is never honoured over the bridge.
  const policy = decide(MODES.BYPASS, ACTIONS.EDIT, { isBridge: true });
  assert.equal(policy.downgraded, true);
  assert.equal(policy.effective, MODES.ACCEPT_EDITS);
});

// ---- through the bridge -----------------------------------------------------

function makeBridge() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => null,
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
  return { kernel, call };
}

test('setPermissionMode accepts auto through the bridge', async () => {
  for (const service of ['LocalSessions', 'LocalAgentModeSessions']) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    const result = await call(service, 'setPermissionMode', s.sessionId, 'auto');
    assert.ok(result, `${service}: auto must be accepted`);
    assert.equal(kernel.getSession(s.sessionId).permissionMode, 'auto', service);
  }
});

test('an existing record holding auto is not treated as corrupt', async () => {
  // 27 sessions on disk carry permissionMode: "auto"; re-saving one must work.
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  await call('LocalSessions', 'setPermissionMode', s.sessionId, 'auto');
  const updated = await call('LocalSessions', 'updateSession', s.sessionId, { title: 'renamed' });
  assert.ok(updated);
  assert.equal(updated.permissionMode, 'auto');
});

test('setPermissionMode accepts dontAsk through the bridge, in both namespaces', async () => {
  // Before the fix this was the ONLY mode refused out of seven: the call answered a
  // value the caller discarded, and the stored mode silently kept its old setting, so
  // picking "Don't ask" in the UI snapped back with no error.
  for (const service of ['LocalSessions', 'LocalAgentModeSessions']) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    const result = await call(service, 'setPermissionMode', s.sessionId, 'dontAsk');
    assert.ok(result, `${service}: dontAsk must be accepted`);
    assert.equal(
      kernel.getSession(s.sessionId).permissionMode,
      'dontAsk',
      `${service}: the stored mode must actually change`
    );
  }
});

test('every UI mode round-trips through setPermissionMode', async () => {
  // One test covering the whole set, so a mode added to the UI but not the bridge shows
  // up here instead of as a picker that silently snaps back.
  const uiModes = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];
  for (const mode of uiModes) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    await call('LocalSessions', 'setPermissionMode', s.sessionId, mode);
    assert.equal(
      kernel.getSession(s.sessionId).permissionMode,
      mode,
      `${mode} must round-trip`
    );
  }
});

test('an unknown mode is still refused', async () => {
  const { kernel, call } = makeBridge();
  const s = kernel.start({ cwd: 'C:\\w' });
  await call('LocalSessions', 'setPermissionMode', s.sessionId, 'auto');
  for (const bad of ['yolo', 'AUTO', 'Automatic', '']) {
    assert.equal(await call('LocalSessions', 'setPermissionMode', s.sessionId, bad), null, bad);
  }
  assert.equal(kernel.getSession(s.sessionId).permissionMode, 'auto');
});
