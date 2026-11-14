// The approval card needs BOTH the right channel and the right payload.
//
// Round 22 wired request/respond but verified only the bridge contract. Running it
// against the real renderer showed the card never appeared, for two separate reasons:
//
//  1. Permission events were emitted only on `..._$_OnEvent`. The frontend's approval
//     store reads that one (shared-11-Ci0VQatJ.js, Jm), but a subscription built from
//     `onOnToolPermissionRequest` listens on `..._$_OnToolPermissionRequest` — a
//     DIFFERENT channel. Both are now emitted.
//
//  2. The payload lacked `input` and `description`. The consumer maps it through
//        Om(sessionId, request) => ({ toolName, input: Gr(t.input), description, ... })
//     so with neither, the card had nothing to render and never painted — even though
//     the request had been delivered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');
const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
const { createApprovalExecutor } = require('../desktop/tool-approval.cjs');

/**
 * A kernel whose emit actually goes through the bridge's channel fan-out, which is how
 * main.cjs wires it (kernelFactory receives the bridge's emit).
 */
function makeHarness() {
  const handlers = new Map();
  const sent = [];
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  let kernel = null;
  registerBridgeServices({
    ipcMain,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    }),
    settings: {
      sidebarMode: 'epitaxy',
      themeMode: 'system',
      kernelFactory: ({ emit }) => {
        kernel = createSessionKernel({
          emit,
          createAgent: () => ({ model: 's', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
        });
        return kernel;
      },
    },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };
  return { get kernel() { return kernel; }, sent, call };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('a permission request reaches both the OnEvent and the method-named channel', async () => {
  // OnEvent is what the approval store reads; OnToolPermissionRequest is what a
  // subscription named after the method reads. Missing either leaves a listener blind.
  const h = makeHarness();
  const s = h.kernel.start({ cwd: 'C:\\w' });
  h.sent.length = 0;

  const pending = h.kernel.requestApproval(s.sessionId, {
    toolName: 'Write',
    input: { path: 'a.txt', content: 'x' },
    description: 'Write a.txt',
  });
  await settle();

  const channels = h.sent.map((m) => m.channel);
  assert.ok(channels.some((c) => c.endsWith('_$_OnEvent')), 'OnEvent is required by the approval store');
  assert.ok(channels.some((c) => c.endsWith('_$_OnToolPermissionRequest')),
    'the method-named channel is required by an onOnToolPermissionRequest subscriber');

  const id = h.kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;
  h.kernel.respondToApproval(id, 'deny');
  await pending;
});

test('the resolution event reaches the method-named channel too', async () => {
  // Without this the card stays on screen after being answered.
  const h = makeHarness();
  const s = h.kernel.start({ cwd: 'C:\\w' });
  const pending = h.kernel.requestApproval(s.sessionId, { toolName: 'Write', input: {} });
  const id = h.kernel.getSession(s.sessionId).pendingToolPermissions[0].requestId;

  h.sent.length = 0;
  h.kernel.respondToApproval(id, 'allow');
  await pending;
  await settle();

  const resolved = h.sent.filter((m) => m.payload && m.payload.type === 'tool_permission_resolved');
  assert.ok(resolved.length > 0, 'the UI needs this to drop the card');
  assert.ok(resolved.some((m) => m.channel.endsWith('_$_OnToolPermissionRequest')));
});

test('the request payload carries what the consumer maps', async () => {
  const h = makeHarness();
  const s = h.kernel.start({ cwd: 'C:\\w' });
  const pending = h.kernel.requestApproval(s.sessionId, {
    toolName: 'Write',
    input: { path: 'a.txt' },
    description: 'Write a.txt',
  });
  await settle();

  const evt = h.sent.find((m) => m.payload && m.payload.type === 'tool_permission_request');
  assert.ok(evt);
  const req = evt.payload.request;
  assert.ok(req, 'the consumer reads `e.request`, not a flat object');
  assert.equal(typeof req.requestId, 'string');
  assert.equal(req.toolName, 'Write');
  // Om() renames requestId to toolUseId and needs these two to render anything.
  assert.ok('input' in req);
  assert.equal(req.description, 'Write a.txt');

  h.kernel.respondToApproval(req.requestId, 'deny');
  await pending;
});

test('the executor asks with input and description, not just a command string', async () => {
  // This is where the payload actually originates.
  const asked = [];
  const execute = createApprovalExecutor({
    mode: 'ask',
    tools: [{ name: 'Write', handler: async () => ({ content: 'ok' }) }],
    ask: async (request) => { asked.push(request); return 'deny'; },
    onEvent: () => {},
  });

  await execute({ name: 'Write', input: { path: 'a.txt', content: 'x' } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].toolName, 'Write');
  assert.deepEqual(asked[0].input, { path: 'a.txt', content: 'x' },
    'without input the card has no details to show');
  assert.ok(asked[0].description && asked[0].description.length > 0,
    'without description the card renders blank');
});

test('a denied tool never runs', async () => {
  let ran = false;
  const execute = createApprovalExecutor({
    mode: 'ask',
    tools: [{ name: 'Write', handler: async () => { ran = true; return { content: 'ok' }; } }],
    ask: async () => 'deny',
    onEvent: () => {},
  });
  const result = await execute({ name: 'Write', input: { path: 'a.txt' } });
  assert.equal(ran, false);
  assert.equal(result.isError, true);
});

test('an allowed tool does run', async () => {
  let ran = false;
  const execute = createApprovalExecutor({
    mode: 'ask',
    tools: [{ name: 'Write', handler: async () => { ran = true; return { content: 'ok' }; } }],
    ask: async () => 'allow',
    onEvent: () => {},
  });
  const result = await execute({ name: 'Write', input: { path: 'a.txt' } });
  assert.equal(ran, true);
  // The success path passes the tool's own result through and adds no error flag.
  assert.notEqual(result.isError, true);
  assert.equal(result.content, 'ok');
});

test('the ask never carries an undefined input', async () => {
  // A tool called with no arguments must still produce a renderable card.
  const asked = [];
  const execute = createApprovalExecutor({
    mode: 'ask',
    tools: [{ name: 'Write', handler: async () => ({ content: 'ok' }) }],
    ask: async (request) => { asked.push(request); return 'deny'; },
    onEvent: () => {},
  });
  await execute({ name: 'Write' });
  assert.equal(typeof asked[0].input, 'object');
  assert.ok(asked[0].input !== null);
});
