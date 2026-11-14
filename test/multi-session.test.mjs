// Several sessions must run at the same time without crossing their transcripts.
//
// Measured this round: five sessions started and messaged concurrently.
//   all sends completed: 5
//   each session: rows=2, hasOwnMsg=true, isRunning=false
//   store valid JSON: true
//
// The failure this guards is a cross-wired transcript: with one shared array or a shared
// 'current session' variable, session 3's message lands in session 1's history and the user
// sees a conversation they never had. It is silent — every call still succeeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** A kernel whose turns take long enough to overlap. */
function overlappingKernel(storePath) {
  return createSessionKernel({
    emit: () => {},
    log: () => {},
    ...(storePath ? { storePath } : {}),
    createAgent: () => ({
      model: 'stub',
      tools: [],
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { text: 'reply' };
      },
    }),
  });
}

test('five concurrent sessions each keep their own transcript', async () => {
  const kernel = overlappingKernel();
  const sessions = Array.from({ length: 5 }, (_, i) => kernel.start({ cwd: ROOT, title: 's' + i }));
  await Promise.all(sessions.map((s, i) => kernel.sendMessage(s.sessionId, 'msg-' + i)));

  for (const [i, session] of sessions.entries()) {
    const text = JSON.stringify(kernel.getTranscript(session.sessionId));
    assert.ok(text.includes('msg-' + i), 'session ' + i + ' lost its own message');
    // And it must not contain any sibling's message.
    const siblings = sessions.map((_, index) => index).filter((index) => index !== i);
    for (const other of siblings) {
      assert.equal(text.includes('msg-' + other), false,
        'session ' + i + ' contains msg-' + other + ', so transcripts are cross-wired');
    }
  }
});

test('every session is idle again after its turn', async () => {
  const kernel = overlappingKernel();
  const sessions = Array.from({ length: 3 }, () => kernel.start({ cwd: ROOT }));
  await Promise.all(sessions.map((s) => kernel.sendMessage(s.sessionId, 'go')));
  for (const session of sessions) {
    assert.equal(kernel.getSession(session.sessionId).isRunning, false,
      'a session was left marked as running');
  }
});

test('cancelling one session leaves the others running', async () => {
  // A shared AbortController would cancel every session at once.
  const kernel = createSessionKernel({
    emit: () => {},
    log: () => {},
    createAgent: () => ({
      model: 'stub',
      tools: [],
      run() { return new Promise((resolve) => setTimeout(() => resolve({ text: 'ok' }), 400)); },
    }),
  });
  const victim = kernel.start({ cwd: ROOT });
  const survivor = kernel.start({ cwd: ROOT });
  kernel.sendMessage(victim.sessionId, 'x').catch(() => {});
  const survivorRun = kernel.sendMessage(survivor.sessionId, 'y');
  await new Promise((resolve) => setTimeout(resolve, 60));
  kernel.cancel(victim.sessionId);
  await survivorRun;
  assert.equal(kernel.getSession(survivor.sessionId).isRunning, false);
  assert.ok(JSON.stringify(kernel.getTranscript(survivor.sessionId)).includes('y'),
    'cancelling one session also stopped another');
});

test('all five sessions persist to one valid store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-store-'));
  const storePath = path.join(dir, 'store.json');
  try {
    const kernel = overlappingKernel(storePath);
    const sessions = Array.from({ length: 5 }, () => kernel.start({ cwd: ROOT }));
    await Promise.all(sessions.map((s, i) => kernel.sendMessage(s.sessionId, 'persist-' + i)));
    kernel.flush();
    assert.ok(fs.existsSync(storePath), 'nothing was persisted');
    const raw = fs.readFileSync(storePath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'concurrent writes produced invalid JSON');
    const data = JSON.parse(raw);
    assert.equal(Object.keys(data.transcripts || {}).length, 5,
      'not every session reached the store');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
