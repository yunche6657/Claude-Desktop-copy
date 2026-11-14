// In-app tool approval must actually reach the renderer and be answerable.
//
// Before this work the bridge never emitted `tool_permission_request` and never
// populated `pendingToolPermissions`, so the in-app approval card could never appear:
// approval happened only through the native consent modal, which the renderer knows
// nothing about. `respondToToolPermission` was also unhandled, answering null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');

function makeKernel() {
  const events = [];
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  return { kernel, events };
}

function makeBridge() {
  const handlers = new Map();
  const events = [];
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: (e) => events.push(e),
    createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const bridge = registerBridgeServices({
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
  return { kernel, bridge, events, call };
}

test('a gated tool raises a request the renderer can subscribe to', async () => {
  const { kernel, events } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  const pending = kernel.requestApproval(s.sessionId, { toolName: 'Bash', command: 'echo hi' });
  const request = events.find((e) => e.type === 'tool_permission_request');
  assert.ok(request, 'the renderer only learns about an approval from this event');
  assert.equal(request.sessionId, s.sessionId);
  assert.ok(request.request.requestId, 'the request needs an id to answer against');
  assert.equal(request.request.toolName, 'Bash');

  kernel.respondToApproval(request.request.requestId, 'allow');
  assert.equal(await pending, 'allow');
});

test('pendingToolPermissions is populated while a prompt is open', async () => {
  // The UI reads this to render the card inside the session.
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });
  assert.deepEqual(kernel.getSession(s.sessionId).pendingToolPermissions, []);

  const pending = kernel.requestApproval(s.sessionId, { toolName: 'Edit' });
  const open = kernel.getSession(s.sessionId).pendingToolPermissions;
  assert.equal(open.length, 1);
  assert.equal(open[0].toolName, 'Edit');

  kernel.respondToApproval(open[0].requestId, 'deny');
  await pending;
  assert.deepEqual(kernel.getSession(s.sessionId).pendingToolPermissions, [],
    'the entry must be cleared once answered');
});

test('allow and deny map to the decisions the executor understands', async () => {
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  const a = kernel.requestApproval(s.sessionId, { toolName: 'Bash' });
  const idA = kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;
  kernel.respondToApproval(idA, 'allow');
  assert.equal(await a, 'allow');

  const b = kernel.requestApproval(s.sessionId, { toolName: 'Bash' });
  const idB = kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;
  kernel.respondToApproval(idB, 'deny');
  assert.equal(await b, 'deny');
});

test('"always" and "once" also allow, and anything else denies', async () => {
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  for (const [decision, expected] of [['always', 'allow'], ['once', 'allow'], ['timeout', 'deny'], ['garbage', 'deny']]) {
    const pending = kernel.requestApproval(s.sessionId, { toolName: 'Bash' });
    const id = kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;
    kernel.respondToApproval(id, decision);
    assert.equal(await pending, expected, decision);
  }
});

test('the decision the desktop card really sends is "once", and it allows', async () => {
  // Measured on a running replica: clicking "Allow once" produced
  //   respondToToolPermission ["perm_1", "once", {path, content}]
  // NOT "allow". A bridge that only recognised "allow" would deny every real click —
  // and it would look correct in a test that only ever sent "allow".
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  const pending = kernel.requestApproval(s.sessionId, { toolName: 'Write' });
  const id = kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;

  const answer = kernel.respondToApproval(id, 'once', { path: 'a.txt', content: 'X' });
  assert.equal(answer.ok, true);
  assert.equal(answer.decision, 'allow', 'the answer reports the normalised decision');
  assert.equal(await pending, 'allow', 'and the executor receives "allow"');
});

test('the resolved event carries the normalised decision, not the renderer spelling', async () => {
  // A UI that reads `request.decision` must see "allow", otherwise it cannot tell an
  // allow from a deny when the renderer's word was "once".
  const { kernel, events } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  const pending = kernel.requestApproval(s.sessionId, { toolName: 'Write' });
  const id = kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;
  kernel.respondToApproval(id, 'once');
  await pending;

  const resolved = events.filter((e) => e.type === 'tool_permission_resolved');
  assert.equal(resolved.length, 1);
  assert.equal(
    resolved[0].request.decision,
    'allow',
    'the event must not leak the raw "once"'
  );
});

test('an edited input rides along on the resolution event', async () => {
  // The card lets a user edit the command before allowing it. The event carries the
  // edited value so a UI showing "what ran" stays truthful.
  const { kernel, events } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  const pending = kernel.requestApproval(s.sessionId, { toolName: 'Bash', input: { command: 'ls' } });
  const id = kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;
  kernel.respondToApproval(id, 'once', { command: 'ls -la' });
  await pending;

  const resolved = events.filter((e) => e.type === 'tool_permission_resolved');
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0].request.input, { command: 'ls -la' });
  assert.equal(resolved[0].request.decision, 'allow');
});

test('a resolution event tells the UI to drop the card', async () => {
  const { kernel, events } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });
  const pending = kernel.requestApproval(s.sessionId, { toolName: 'Bash' });
  const id = kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;

  kernel.respondToApproval(id, 'allow');
  await pending;

  const resolved = events.find((e) => e.type === 'tool_permission_resolved');
  assert.ok(resolved, 'without this the card stays on screen');
  assert.equal(resolved.request.decision, 'allow');
});

test('cancelling the turn settles an open prompt instead of hanging', async () => {
  // The exact hang that locked a session in round 21: a tool awaiting an answer that
  // never arrives.
  const { kernel, events } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });
  const pending = kernel.requestApproval(s.sessionId, { toolName: 'Bash' });

  kernel.cancel(s.sessionId);
  assert.equal(await pending, 'deny', 'the waiter must be released');
  assert.deepEqual(kernel.getSession(s.sessionId).pendingToolPermissions, []);

  const resolved = events.find((e) => e.type === 'tool_permission_resolved');
  assert.ok(resolved);
});

test('answering an unknown request reports failure instead of throwing', async () => {
  const { kernel } = makeKernel();
  const result = kernel.respondToApproval('perm_nope', 'allow');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no such request');
});

test('respondToToolPermission is handled in both namespaces', async () => {
  for (const service of ['LocalSessions', 'LocalAgentModeSessions']) {
    const { kernel, call } = makeBridge();
    const s = kernel.start({ cwd: 'C:\\w' });
    const pending = kernel.requestApproval(s.sessionId, { toolName: 'Bash' });
    const id = kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;

    const answer = await call(service, 'respondToToolPermission', id, 'allow');
    assert.equal(answer.ok, true, service);
    assert.equal(await pending, 'allow', service);
  }
});

test('respondToToolPermission refuses an empty request id', async () => {
  const { call } = makeBridge();
  for (const bad of ['', null, undefined, 42]) {
    const result = await call('LocalSessions', 'respondToToolPermission', bad, 'allow');
    assert.equal(result.ok, false);
  }
});

test('the bridge exposes requestApproval for the host to prefer the in-app card', async () => {
  // main.cjs uses this to route approval in-app, falling back to the native modal.
  const { bridge } = makeBridge();
  assert.equal(typeof bridge.requestApproval, 'function');
});

test('an unanswered prompt times out instead of hanging the turn', async () => {
  // A bridge-level request has no session to cancel, so the timeout is the only thing
  // that can settle it. Without this the promise (and the tool awaiting it) leaks.
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  const pending = kernel.requestApproval(s.sessionId, { toolName: 'Bash' }, { timeoutMs: 50 });
  assert.equal(await pending, 'timeout');
  assert.deepEqual(kernel.getSession(s.sessionId).pendingToolPermissions, [],
    'the entry must be cleared on timeout too');
});

test('two open prompts are answered independently', async () => {
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: 'C:\\w' });

  const first = kernel.requestApproval(s.sessionId, { toolName: 'Bash' });
  const second = kernel.requestApproval(s.sessionId, { toolName: 'Edit' });
  const ids = kernel.getSession(s.sessionId).pendingToolPermissions.map((p) => p.requestId);
  assert.equal(ids.length, 2);

  kernel.respondToApproval(ids[0], 'allow');
  kernel.respondToApproval(ids[1], 'deny');
  assert.equal(await first, 'allow');
  assert.equal(await second, 'deny');
});

// ---------------------------------------------------------------------------
// The renderer may downgrade an ALLOW to a DENY before it ever reaches the bridge.
//
// shared-11-Ci0VQatJ.js:
//   let l = a!=="deny" && (s===void 0 || !xt(s)) && En(c,i) ? "deny" : a;
//
// with the helpers resolved from shared-78-BDwyc9QD.js:
//   xt = aD = (...xs) => xs.every(x => x===undefined || (x.suppressAlwaysAllowRule!==true
//                                                       && x.askFlagsUnknown!==true))
//   En = gD = (e,t) => (e!==undefined && e.startsWith("computer:")) || (t!==undefined && "_cuGrants" in t)
//
// So an allow survives only while En(...) is false. For the tools this build serves that
// holds: the tool names are Write/Edit/Read/Glob/List/Bash (none starts with "computer:")
// and no request carries `_cuGrants`. These tests pin the invariant, because a future
// `computer:`-prefixed tool or a stray `_cuGrants` field would silently turn every user
// "Allow" into a deny.
//
// Verified end to end too: in ask mode a Write raised a card, clicking "Allow once"
// created the file with the expected contents.

/** Mirror of the renderer's `xt` (aD in shared-78-BDwyc9QD.js). */
const suppressesAlwaysAllow = (...xs) =>
  xs.every((x) => x === undefined
    || (x.suppressAlwaysAllowRule !== true && x.askFlagsUnknown !== true));

/** Mirror of the renderer's `En` (gD in shared-78-BDwyc9QD.js). */
const needsExtraConsent = (toolName, decisionOrExtras) =>
  (toolName !== undefined && typeof toolName === 'string' && toolName.startsWith('computer:'))
  || (decisionOrExtras !== undefined
      && typeof decisionOrExtras === 'object'
      && decisionOrExtras !== null
      && '_cuGrants' in decisionOrExtras);

/** The renderer's downgrade rule, verbatim. */
const downgradeAllow = (decision, requestShape, toolName) =>
  (decision !== 'deny'
    && (requestShape === undefined || !suppressesAlwaysAllow(requestShape))
    && needsExtraConsent(toolName, decision))
    ? 'deny'
    : decision;

test('the tools this build serves never trigger the allow-downgrade path', async () => {
  const served = ['Read', 'List', 'Glob', 'Write', 'Edit', 'Bash'];
  for (const toolName of served) {
    assert.equal(
      needsExtraConsent(toolName, 'allow'),
      false,
      `${toolName} must not require extra consent`
    );
    assert.equal(
      downgradeAllow('allow', { toolName }, toolName),
      'allow',
      `${toolName}: an allow must survive`
    );
  }
});

test('the payload the executor REALLY builds keeps an allow intact', async () => {
  // The point of this test is that it captures the payload from createApprovalExecutor
  // rather than restating it. An earlier version hand-wrote the shape, so adding a
  // `_cuGrants` field to the real executor left the test green while the UI would have
  // turned every Allow into a deny.
  const { createApprovalExecutor } = require('../desktop/tool-approval.cjs');

  let captured = null;
  const tools = [{ name: 'Write', handler: async () => ({ content: 'ran' }) }];
  const executor = createApprovalExecutor({
    mode: 'ask',
    tools,
    onEvent: () => {},
    ask: async (payload) => { captured = payload; return 'allow'; },
    isBridge: false,
  });

  await executor({ name: 'Write', input: { path: 'allow-probe.txt', content: 'ALLOWED' } });

  assert.ok(captured, 'the executor must have asked');
  assert.equal(captured.toolName, 'Write');
  assert.ok(captured.input, 'the card needs the arguments');
  assert.ok(captured.description, 'the card needs a description');

  // The invariant: nothing in this payload may trip the renderer's downgrade rule.
  assert.equal(
    suppressesAlwaysAllow(captured),
    true,
    'no suppressAlwaysAllowRule / askFlagsUnknown may be set'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(captured, '_cuGrants'),
    false,
    '_cuGrants would make the renderer downgrade an allow to a deny'
  );
  assert.equal(
    downgradeAllow('allow', captured, captured.toolName),
    'allow',
    'a real allow must survive the renderer rule'
  );
});

test('the downgrade rule is real, so the guard above is meaningful', async () => {
  // Prove the mirrored rule can actually fire; otherwise the two tests above would pass
  // against a no-op and protect nothing.
  assert.equal(needsExtraConsent('computer:something', 'allow'), true);
  assert.equal(downgradeAllow('allow', undefined, 'computer:something'), 'deny');
  assert.equal(downgradeAllow('allow', undefined, 'Write'), 'allow');
  assert.equal(
    downgradeAllow('allow', { suppressAlwaysAllowRule: true }, 'Write'),
    'allow',
    'suppressing the always-allow rule alone does not downgrade'
  );
});

test('a computer: tool would be the one case that changes behaviour', async () => {
  // Recorded so the reason is visible: if a `computer:`-prefixed tool is ever added to
  // TOOL_ACTIONS, an allow it prompts for would be turned into a deny by the renderer.
  const { actionFor, TOOL_ACTIONS } = require('../desktop/tool-approval.cjs');
  const names = Object.keys(TOOL_ACTIONS);
  assert.equal(
    names.some((n) => n.startsWith('computer:')),
    false,
    'none of the mapped tools uses the computer: prefix'
  );
  for (const n of names) {
    assert.equal(needsExtraConsent(n, 'allow'), false, n);
    assert.equal(typeof actionFor(n), 'string');
  }
});
