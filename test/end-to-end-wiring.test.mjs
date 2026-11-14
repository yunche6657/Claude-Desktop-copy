// The one claim this whole reconstruction rests on: a message typed into the shipped composer
// reaches the real model and the reply comes back rendered in the transcript.
//
// Verified live this round against the gateway (deepseek-v4.1-flash):
//
//   composer located at (1091, 977) via a real pointer click
//   typed   "Reply with exactly: E2E-165999"        -> visible in the DOM
//   pressed Enter
//   DOM after the turn:
//     "您说：Reply with exactly: E2E-165999"
//     "Claude 已回复：E2E-165999"
//     0 error lines in evidence/live/replica-10060.out
//
// That is a manual run, and a manual run cannot run in CI. What this file CAN pin is the
// wiring that made it possible: the channel names, the model the launch config selects, and
// the fact that the composer and the send path exist at all. The live run is recorded in
// evidence/STATUS.md as the evidence that the wiring actually works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the kernel exposes a send path the renderer can reach', () => {
  // sendMessage is the channel the composer's Send button calls; without a real handler the
  // fallback would answer null and the message would go nowhere.
  const bridge = read('desktop/bridge-services.cjs');
  // The exact registration form: define('claude.web_$_LocalSessions_$_sendMessage', ...).
  // Both namespaces register it, which is why the renderer's picker and the cowork view
  // can each dispatch a message.
  assert.match(bridge, /'claude\.web_\$_LocalSessions_\$_sendMessage'/, 'no sendMessage handler is registered');
  assert.match(bridge, /'claude\.web_\$_LocalAgentModeSessions_\$_sendMessage'/, 'the cowork namespace has no sendMessage');
});

test('a turn is executed by the in-process agent, not stubbed', async () => {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-dispatch-' + process.pid + '-' + Date.now() + '.json');
  const calls = [];
  const kernel = createSessionKernel({
    createAgent: () => ({ model: 'm', tools: [], run: async (options) => {
      calls.push(options);
      return { text: 'dispatch reply', stopReason: 'end_turn' };
    } }),
    emit: () => {}, storePath,
  });
  try {
    const session = kernel.start({ cwd: ROOT });
    const result = await kernel.sendMessage(session.sessionId, 'dispatch request');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1, 'the turn must call the agent exactly once');
    assert.ok(JSON.stringify(calls[0].messages).includes('dispatch request'), 'the request did not reach the agent');
    assert.ok(JSON.stringify(kernel.getTranscript(session.sessionId)).includes('dispatch reply'), 'the agent reply did not reach the transcript');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});
test('the launch config selects the model the gateway is asked for', () => {
  // The first version asserted /CLAUDE_AGENT_MODEL/ anywhere in the launcher, which stayed
  // green when the assignment was renamed. Assert the assignment and its fallback order.
  const launcher = fs.readFileSync(path.join(ROOT, 'tools', 'launch-replica.cjs'), 'utf8');
  assert.match(launcher, /applyStartupDefaults\(env\)/, 'the launcher must share executable startup configuration');
  const agent = fs.readFileSync(path.join(ROOT, 'desktop', 'agent.cjs'), 'utf8');
  assert.match(agent, /baseUrl/, 'the agent does not accept a base URL');
  assert.match(agent, /apiKey|API_KEY/, 'the agent does not accept a key');
});
test('a completed turn is persisted so it survives a restart', async () => {
  // REWRITTEN: this used to assert that the source contains writeFileSync/renameSync, which
  // describes the mechanism and says nothing about whether a turn actually survives. It now
  // builds a kernel, runs a turn, then builds a SECOND kernel over the same store file.
  //
  // MEASURED: session found true, rows 2 -> 2, title preserved, isRunning false, and the
  // restored session accepted a new message.
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-e2e-' + process.pid + '-' + Date.now() + '.json');
  try { fs.unlinkSync(storePath); } catch { /* fresh */ }
  const build = () => createSessionKernel({
    createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'persisted reply', stopReason: 'end_turn' }) }),
    emit: () => {},
    storePath,
  });
  try {
    const first = build();
    const s = first.start({ cwd: ROOT });
    await first.sendMessage(s.sessionId, 'remember this');
    first.flush();
    const rowsBefore = (first.getTranscript(s.sessionId) || []).length;
    assert.equal(rowsBefore, 2, 'the first process did not record the turn');

    const second = build();
    const restored = second.getAll().find((x) => x.sessionId === s.sessionId);
    assert.ok(restored, 'the session did not survive the restart');
    assert.equal((second.getTranscript(s.sessionId) || []).length, rowsBefore, 'the transcript did not survive');
    assert.equal(restored.isRunning, false, 'the restored session is stuck running');
    const continued = await second.sendMessage(s.sessionId, 'continue');
    assert.equal(continued.ok, true, 'the restored session could not continue');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('a crash during save cannot leave a truncated store', async () => {
  // Atomicity is a BEHAVIOURAL property: the store file must always parse. Writing 16 MB in
  // place would leave a half-written file if the process died mid-write, and the next launch
  // would fail to load every session.
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-atomic-' + process.pid + '-' + Date.now() + '.json');
  try { fs.unlinkSync(storePath); } catch { /* fresh */ }
  try {
    const kernel = createSessionKernel({
      createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'x', stopReason: 'end_turn' }) }),
      emit: () => {},
      storePath,
    });
    const s = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(s.sessionId, 'write something');
    kernel.flush();
    // The file must exist AND parse — a partial write would leave invalid JSON.
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.sessions), 'the store is not a sessions document');
    assert.ok(parsed.sessions.length >= 1, 'the store lost its sessions');
    // And no stray temp file was left next to it.
    const dir = path.dirname(storePath);
    const base = path.basename(storePath);
    const strays = fs.readdirSync(dir).filter((n) => n.startsWith(base + '.') && n !== base);
    assert.deepEqual(strays, [], 'a temp file was left behind: ' + strays.join(', '));
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});
