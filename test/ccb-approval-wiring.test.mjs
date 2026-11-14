// The CCB approval path must travel through session-kernel, not around it.
//
// Two defects were found here by wiring the test to the PRODUCTION path instead of injecting a
// construction-time hook:
//
//   1. ccb-kernel read the approval hook at CONSTRUCTION time, while session-kernel supplies it
//      PER TURN. Session-kernel's hook was therefore never consulted: every tool fell through
//      to "no approval hook is wired" and was silently denied.
//   2. ccb-kernel ALSO emitted its own tool_permission_request, keyed by the kernel's own
//      request_id. The renderer saw two events; answering the first returned
//      {"ok":false,"reason":"no such request"} because session-kernel never minted that id.
//
// Both defects are invisible if a test passes canUseTool at construction. So these tests pass
// nothing at construction and drive the real handshake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ccbSource = fs.readFileSync(path.join(ROOT, 'desktop', 'ccb-kernel.cjs'), 'utf8');
const kernelSource = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');

// A child that asks for permission and, once answered, reports the decision it received.
const FAKE = `
'use strict';
const readline = require('node:readline');
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'fake', tools: ['Bash'], permissionMode: 'default' });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === 'control_request') {
    if (frame.request && frame.request.subtype === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
        response: { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] } } });
      return;
    }
    if (frame.request && frame.request.subtype === 'set_permission_mode') {
      const error = process.env.CCB_TEST_REJECT_PERMISSION === '1';
      out({ type: 'control_response', response: { subtype: error ? 'error' : 'success', request_id: frame.request_id,
        ...(error ? { error: 'permission switch rejected' } : { response: { mode: frame.request.mode } }) } });
      return;
    }
    if (frame.request && frame.request.subtype === 'apply_flag_settings') {
      if (Object.keys(frame.request.settings).join(',') !== 'effortLevel') throw new Error('effort control changed permission settings');
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
      return;
    }
    if (frame.request && frame.request.subtype === 'can_use_tool') {
      out({ type: 'control_request', request_id: 'perm-from-kernel',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo HI' }, tool_use_id: 'tu_1' } });
      return;
    }
    return;
  }
  if (frame.type === 'user') {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo HI' } }] },
      parent_tool_use_id: null, session_id: 'fake' });
    out({ type: 'control_request', request_id: 'perm-from-kernel',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo HI' }, tool_use_id: 'tu_1' } });
    return;
  }
  if (frame.type === 'control_response') {
    const behavior = frame.response.response.behavior;
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'TOOL RAN', is_error: false }] },
      parent_tool_use_id: null, session_id: 'fake' });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ANSWER:' + behavior }] },
      parent_tool_use_id: null, session_id: 'fake' });
    out({ type: 'result', subtype: 'success', result: 'ANSWER:' + behavior, stop_reason: 'end_turn', session_id: 'fake' });
  }
});
`;

function makeKernel(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'approval-wiring-'));
  const entry = path.join(dir, 'cli-bun.js');
  writeFileSync(entry, FAKE);
  return createCcbKernel({ bunPath: process.execPath, entryPath: entry, kernelRoot: dir, turnTimeoutMs: 8000, startupTimeoutMs: 8000, ...options });
}

/** Wait for an event matching the predicate, with a real timeout. */
async function waitFor(events, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('event not observed within ' + timeoutMs + 'ms');
}

test('a construction-time hook is not the only source: a per-turn one is honoured', () => {
  // The defect in source form: reading only options.canUseTool means the per-turn hook is dead.
  assert.match(ccbSource, /state\.requestApproval/, 'the backend must consult the per-turn hook');
  assert.match(ccbSource, /typeof opts\.requestApproval === 'function'/, 'and store it when a turn starts');
});

test('the backend only emits its own card when no hook owns it', () => {
  // Two events for one prompt makes the renderer answer an id session-kernel never minted,
  // which returns "no such request" AFTER the user already approved. So the backend's own
  // emission must sit inside the no-hook branch.
  const guardIndex = ccbSource.indexOf("if (typeof hook !== 'function') {");
  const emitIndex = ccbSource.indexOf("type: 'tool_permission_request'");
  assert.ok(guardIndex > 0, 'there must be a no-hook branch');
  assert.ok(emitIndex > guardIndex, 'the backend card must only be emitted in that branch');
  assert.ok(emitIndex - guardIndex < 400, 'and immediately inside it');
});

test('the real handshake: session-kernel cards the request, allow reaches the kernel', async () => {
  const kernel = makeKernel();
  const events = [];
  const session = createSessionKernel({ emit: (event) => events.push(event), backend: kernel });
  try {
    const started = session.start({ cwd: tmpdir() });
    const turn = session.sendMessage(started.sessionId, 'PERMISSION please');
    const card = await waitFor(events, (event) => event.type === 'tool_permission_request' && event.request);
    assert.equal(card.request.toolName, 'Bash', 'the card names the tool');
    assert.match(card.request.requestId, /^perm_\d+$/, 'the id must be one session-kernel minted');
    assert.equal(session.respondToApproval(card.request.requestId, 'allow').ok, true);
    const result = await turn;
    assert.equal(result.ok, true, 'the turn must complete once the card is answered');
    assert.equal(result.text, 'ANSWER:allow', 'the kernel must receive the allow decision');
  } finally {
    await kernel.dispose();
  }
});

test('exactly one card event is emitted per prompt', async () => {
  const kernel = makeKernel();
  const events = [];
  const session = createSessionKernel({ emit: (event) => events.push(event), backend: kernel });
  try {
    const started = session.start({ cwd: tmpdir() });
    const turn = session.sendMessage(started.sessionId, 'PERMISSION please');
    const card = await waitFor(events, (event) => event.type === 'tool_permission_request' && event.request);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cards = events.filter((event) => event.type === 'tool_permission_request');
    assert.equal(cards.length, 1, 'a second card for the same prompt means the renderer gets a dead id');
    session.respondToApproval(card.request.requestId, 'allow');
    await turn;
  } finally {
    await kernel.dispose();
  }
});

test('denying the card denies the tool and still finishes the turn', async () => {
  const kernel = makeKernel();
  const events = [];
  const session = createSessionKernel({ emit: (event) => events.push(event), backend: kernel });
  try {
    const started = session.start({ cwd: tmpdir() });
    const turn = session.sendMessage(started.sessionId, 'PERMISSION please');
    const card = await waitFor(events, (event) => event.type === 'tool_permission_request' && event.request);
    session.respondToApproval(card.request.requestId, 'deny');
    const result = await turn;
    assert.equal(result.ok, true, 'a denied tool is data, not a failed turn');
    assert.equal(result.text, 'ANSWER:deny');
  } finally {
    await kernel.dispose();
  }
});

test('only explicit bypass skips approvals, including switching back on the same actor', async () => {
  const kernel = makeKernel();
  const events = [];
  const session = createSessionKernel({ emit: event => events.push(event), backend: kernel });
  try {
    const started = session.start({ cwd: tmpdir(), permissionMode: 'bypassPermissions' });
    assert.equal((await session.sendMessage(started.sessionId, 'bypass')).text, 'ANSWER:allow');
    assert.equal(events.filter(event => event.type === 'tool_permission_request').length, 0);
    // Exercise the child control directly: selected bypass must not stick after a mode change.
    let calls = 0;
    const opts = { permissionMode: 'default', requestApproval: () => { calls++; return 'deny'; } };
    assert.equal((await kernel.sendMessage(started.sessionId, 'default', opts)).text, 'ANSWER:deny');
    assert.equal(calls, 1);
    assert.equal((await kernel.sendMessage(started.sessionId, 'bypass again', { permissionMode: 'bypassPermissions', requestApproval: () => { throw new Error('unexpected approval'); } })).text, 'ANSWER:allow');
  } finally { await kernel.dispose(); }
});

test('rejected permission controls stop before sending a new user turn', async () => {
  const kernel = makeKernel({ env: { CCB_TEST_REJECT_PERMISSION: '1' } });
  try {
    await kernel.sendMessage('reject-mode', 'first', { permissionMode: 'bypassPermissions' });
    await assert.rejects(kernel.sendMessage('reject-mode', 'must not run', { permissionMode: 'default' }), /permission switch rejected/);
  } finally { await kernel.dispose(); }
});

test('acceptEdits, plan and default still consult the approval owner', async () => {
  for (const permissionMode of ['default', 'acceptEdits', 'plan']) {
    const kernel = makeKernel();
    try {
      let calls = 0;
      const result = await kernel.sendMessage('mode-' + permissionMode, 'ask', { permissionMode, requestApproval: () => { calls++; return 'deny'; } });
      assert.equal(result.text, 'ANSWER:deny');
      assert.equal(calls, 1, permissionMode);
    } finally { await kernel.dispose(); }
  }
});

test('with no hook at all the tool is denied rather than left hanging', async () => {
  // A kernel that never gets an answer blocks forever, which is the round-21 hang.
  const kernel = makeKernel();
  try {
    kernel.start({ sessionId: 'no-hook' });
    const cardEvents = [];
    kernel.onEvent((event) => cardEvents.push(event));
    const result = await kernel.sendMessage('no-hook', 'PERMISSION please', {});
    assert.equal(result.text, 'ANSWER:deny');
    const card = cardEvents.find((event) => event.type === 'tool_permission_request');
    assert.ok(card, 'the ownerless case must still be reported, with a reason');
    assert.match(card.request.unavailableReason, /no approval hook/);
  } finally {
    await kernel.dispose();
  }
});
