import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

function fixtureBackend() {
  const listeners = new Set();
  const actors = new Map();
  return {
    id: 'fixture',
    start() {},
    async sendMessage() { return { text: '', stopReason: 'end_turn' }; },
    cancel() {},
    dispose() {},
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    collectSessionLoops(id) { return actors.get(id)?.loops; },
    getInfo(id) { const actor = actors.get(id); return actor ? { actorToken: actor.token } : null; },
    setActor(id, token, loops) { actors.set(id, { token, loops }); },
    notify(id, actorToken) {
      for (const listener of [...listeners]) listener({ type: 'loops_changed', sessionId: id, actorToken });
    },
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const row = (id, prompt) => ({ id, prompt, cron: '*/5 * * * *', humanSchedule: 'Every 5 minutes',
  createdAt: 1_700_000_000_000, nextRunAt: 1_700_000_300_000, recurring: true });

test('loop lifetime constant is exactly three days', () => {
  assert.equal(2592e5, 259_200_000);
  assert.equal(2592e5, 3 * 24 * 60 * 60 * 1000);
});

test('getSession and getAll project current actor loops without sharing sessions', () => {
  const backend = fixtureBackend();
  const kernel = createSessionKernel({ backend, emit() {} });
  const first = kernel.start({ cwd: 'C:\\work' }).sessionId;
  const second = kernel.start({ cwd: 'C:\\work' }).sessionId;
  assert.equal(kernel.getSession(first).loops, undefined);
  const job = row('job-a', 'private fixture prompt');
  backend.setActor(first, 'epoch-a', [job]);
  backend.setActor(second, 'epoch-b', []);
  assert.deepEqual(kernel.getSession(first).loops, [job]);
  assert.deepEqual(kernel.getSession(second).loops, []);
  const sessions = kernel.getAll();
  assert.deepEqual(sessions.find(s => s.sessionId === first).loops, [job]);
  assert.deepEqual(sessions.find(s => s.sessionId === second).loops, []);
  backend.setActor(first, 'epoch-a', []);
  assert.deepEqual(kernel.getSession(first).loops, []);
  kernel.dispose();
});

test('idle backend loop changes emit projected session_updated, and old epochs do not restore old jobs', async () => {
  const events = [];
  const backend = fixtureBackend();
  const kernel = createSessionKernel({ backend, emit: event => events.push(event) });
  const id = kernel.start({ cwd: 'C:\\work' }).sessionId;
  events.length = 0;
  const job = row('job-a', 'background prompt');
  backend.setActor(id, 'epoch-a', [job]);
  backend.notify(id, 'epoch-a');
  await tick();
  let updates = events.filter(e => e.type === 'session_updated' && e.sessionId === id);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].session.loops, [job]);
  assert.equal(events.some(e => e.type === 'loops_changed'), false, 'backend event is private');

  backend.setActor(id, 'epoch-a', []);
  backend.notify(id, 'epoch-a');
  await tick();
  updates = events.filter(e => e.type === 'session_updated' && e.sessionId === id);
  assert.deepEqual(updates.at(-1).session.loops, []);

  backend.setActor(id, 'epoch-b', []);
  backend.notify(id, 'epoch-b');
  await tick();
  backend.notify(id, 'epoch-a');
  await tick();
  assert.deepEqual(kernel.getSession(id).loops, []);
  updates = events.filter(e => e.type === 'session_updated' && e.sessionId === id);
  assert.deepEqual(updates.at(-1).session.loops, []);
  kernel.dispose();
});

test('loop data is exposed to the UI but is not written into the session store', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-loops-r370-'));
  const storePath = path.join(dir, 'sessions.json');
  const backend = fixtureBackend();
  const kernel = createSessionKernel({ backend, storePath, emit() {} });
  try {
    const id = kernel.start({ cwd: 'C:\\work' }).sessionId;
    const prompt = 'private-loop-fixture-never-persist';
    backend.setActor(id, 'epoch-a', [row('job-a', prompt)]);
    assert.equal(kernel.getSession(id).loops[0].prompt, prompt);
    kernel.update(id, { title: 'Persisted session' });
    kernel.flush();
    const stored = readFileSync(storePath, 'utf8');
    assert.equal(stored.includes(prompt), false);
    const data = JSON.parse(stored);
    assert.equal(data.sessions.find(s => s.sessionId === id).loops, undefined);
  } finally {
    kernel.dispose();
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(dir, { recursive: true, force: true });
  }
});
