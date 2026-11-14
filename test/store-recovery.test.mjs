// A corrupt or missing session store must not prevent the app from working.
//
// Measured this round, five damaged-store cases, each followed by a real turn:
//
//   missing store   started=ok  rows=2
//   empty file      started=ok  rows=2
//   invalid JSON    started=ok  rows=2
//   wrong shape     started=ok  rows=2
//   null sessions   started=ok  rows=2
//
// and the damage is repaired rather than tolerated forever:
//   store rewritten as valid JSON: true
//     sessions: 1 | transcripts: 1
//   second start sees session: true
//
// The user-visible failure this prevents: one bad byte in the store and the app refuses to
// open, or opens with an empty conversation list. Neither is recoverable without deleting
// files by hand.
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

function kernelAt(storePath) {
  return createSessionKernel({
    emit: () => {},
    log: () => {},
    storePath,
    createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } }),
  });
}

const DAMAGE = {
  'missing store': (p) => { if (fs.existsSync(p)) fs.rmSync(p); },
  'empty file': (p) => fs.writeFileSync(p, ''),
  'invalid JSON': (p) => fs.writeFileSync(p, '{not json'),
  'wrong shape': (p) => fs.writeFileSync(p, JSON.stringify({ hello: 'world' })),
  'null collections': (p) => fs.writeFileSync(p, JSON.stringify({ sessions: null, transcripts: null })),
};

test('every kind of damaged store still lets a turn run', async () => {
  for (const [name, damage] of Object.entries(DAMAGE)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-'));
    const storePath = path.join(dir, 'store.json');
    try {
      damage(storePath);
      const kernel = kernelAt(storePath);
      const session = kernel.start({ cwd: ROOT });
      await kernel.sendMessage(session.sessionId, 'boot-check');
      const rows = kernel.getTranscript(session.sessionId);
      assert.ok(Array.isArray(rows) && rows.length >= 2,
        name + ': the turn produced no transcript');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a corrupt store is rewritten as valid JSON', async () => {
  // Tolerating the damage forever would mean every launch starts from nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-'));
  const storePath = path.join(dir, 'store.json');
  try {
    fs.writeFileSync(storePath, '{corrupt');
    const kernel = kernelAt(storePath);
    const session = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(session.sessionId, 'after corruption');
    kernel.flush();

    const raw = fs.readFileSync(storePath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'the store is still not valid JSON after a turn');
    const data = JSON.parse(raw);
    assert.equal((data.sessions || []).length, 1, 'the recovered store does not hold the new session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session created after corruption is visible on the next start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover2-'));
  const storePath = path.join(dir, 'store.json');
  try {
    fs.writeFileSync(storePath, 'not json at all');
    const first = kernelAt(storePath);
    const session = first.start({ cwd: ROOT });
    await first.sendMessage(session.sessionId, 'survivor');
    first.flush();

    const second = kernelAt(storePath);
    assert.ok(second.getSession(session.sessionId), 'the recovered session vanished on restart');
    assert.ok(JSON.stringify(second.getTranscript(session.sessionId)).includes('survivor'),
      'the recovered transcript lost its content');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a valid store is not discarded', async () => {
  // The recovery path must not wipe good data — that would be worse than the corruption.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-'));
  const storePath = path.join(dir, 'store.json');
  try {
    const first = kernelAt(storePath);
    const session = first.start({ cwd: ROOT, title: 'precious' });
    await first.sendMessage(session.sessionId, 'keep me');
    first.flush();

    const second = kernelAt(storePath);
    assert.equal(second.getSession(session.sessionId).title, 'precious');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
