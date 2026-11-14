// EIPC layer tests.
//
// These cover the parts that do not need a running Electron process: channel
// naming against the observed @ant/ipc-codegen template, the sender-view
// check, and the shared session facade that both hosts drive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const { EipcBus, VIEW, buildMessageChannel, buildEventChannel, EIPC_NAMESPACE } =
  await import('../desktop/eipc-bus.cjs');
const { createApp } = await import('../server.mjs');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

test('channel names follow the observed codegen template', () => {
  assert.equal(
    buildMessageChannel('claude.web', 'LocalAgentSessions', 'sendPrompt'),
    `$eipc_message$_${EIPC_NAMESPACE}_$_claude.web_$_LocalAgentSessions_$_sendPrompt`,
  );
  assert.equal(
    buildEventChannel('claude.web', 'LocalAgentSessions', 'sessionEvent'),
    `$eipc_event$_${EIPC_NAMESPACE}_$_claude.web_$_LocalAgentSessions_$_sessionEvent`,
  );
  // Separator shape must match the bundle: _$_ between every component.
  assert.match(buildMessageChannel('a', 'b', 'c'), /^\$eipc_message\$_[^$]+_\$_a_\$_b_\$_c$/);
  assert.match(buildEventChannel('a', 'b', 'c'), /^\$eipc_event\$_[^$]+_\$_a_\$_b_\$_c$/);
});

test('an unregistered sender is rejected and allowedViews is enforced', async () => {
  const ipc = fakeIpcMain();
  const bus = new EipcBus(ipc);
  bus.registerService('claude.web', 'AppFeatures', { ping: () => 'pong' }, { allowedViews: [VIEW.MAIN_WINDOW] });
  const channel = buildMessageChannel('claude.web', 'AppFeatures', 'ping');
  const handler = ipc.handlers.get(channel);
  assert.ok(handler, 'handler must be registered under the codegen channel name');

  await assert.rejects(() => handler({ sender: {} }), /unregistered sender/);

  const allowedSender = { id: 1 };
  bus.registerView(allowedSender, VIEW.MAIN_WINDOW);
  assert.equal(await handler({ sender: allowedSender }), 'pong');

  const otherSender = { id: 2 };
  bus.registerView(otherSender, VIEW.CLAUDE_AI_WEB);
  await assert.rejects(() => handler({ sender: otherSender }), /may not call/);

  bus.dispose();
  assert.equal(ipc.handlers.size, 0, 'dispose must remove every handler');
});

test('emit targets the event channel and tolerates a destroyed view', () => {
  const ipc = fakeIpcMain();
  const bus = new EipcBus(ipc);
  const sent = [];
  const live = { isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) };
  assert.equal(bus.emit(live, 'claude.web', 'AppFeatures', 'settingsChanged', { theme: 'dark' }), true);
  assert.equal(sent[0][0], buildEventChannel('claude.web', 'AppFeatures', 'settingsChanged'));
  assert.deepEqual(sent[0][1], { theme: 'dark' });

  const dead = { isDestroyed: () => true, send: () => { throw new Error('must not send'); } };
  assert.equal(bus.emit(dead, 'claude.web', 'AppFeatures', 'settingsChanged', {}), false);
});

test('the shared session facade drives one store for both hosts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'code-desktop-eipc-'));
  const server = createApp({ dataDir: dir, mode: 'demo' });
  try {
    const created = server.sessions.create({ title: 'EIPC 会话', projectPath: '' });
    assert.equal(typeof created.id, 'string');

    const seen = [];
    const { runId } = server.sessions.send(created.id, '你好', event => seen.push(event));
    assert.equal(typeof runId, 'string');

    await new Promise(resolve => setTimeout(resolve, 900));
    const types = seen.map(event => event.type);
    assert.ok(types.includes('status'), 'sink must receive the running status frame');
    assert.ok(types.includes('text'), 'sink must receive streamed text');
    assert.ok(types.includes('done'), 'sink must receive the terminal frame');

    const stored = server.sessions.get(created.id);
    assert.equal(stored.messages.length, 2);
    assert.ok(stored.messages[1].text.length > 0, 'assistant text must be persisted');

    assert.deepEqual(server.sessions.list().map(s => s.id), [created.id]);
    assert.deepEqual(server.sessions.remove(created.id), { ok: true, id: created.id });
    assert.equal(server.sessions.list().length, 0);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing sink cannot break the run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'code-desktop-eipc-sink-'));
  const server = createApp({ dataDir: dir, mode: 'demo' });
  try {
    const created = server.sessions.create({ title: 'sink', projectPath: '' });
    server.sessions.send(created.id, 'hi', () => { throw new Error('dead sink'); });
    await new Promise(resolve => setTimeout(resolve, 900));
    const stored = server.sessions.get(created.id);
    assert.equal(stored.messages[1].status, 'completed', 'run must complete despite a dead sink');
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
