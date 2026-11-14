import { PINNED_ION_DIST } from './helpers/pinned-frontend.mjs';
// The first run must work: an empty store, one message, a persisted session.
//
// Measured this round on a fresh store:
//   sessions on a fresh store: 0
//   getAll returns array: true      (not null — the sidebar iterates it)
//   after first turn, sessions: 1 rows: 2
//   store written: true
//
// and the live app at startup shows the sidebar, the composer, the model selector and the
// real session list (visible test ids measured: sidebar, code-prompt-input, code-prompt-send,
// epitaxy-cds-model-selector, user-menu-button).
//
// The empty state string lives in the shipped bundle ("Sessions you start will show up here",
// cbd6c85c8-D1xuycDy.js), so it is not something this reconstruction invents.
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

function freshKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-'));
  const storePath = path.join(dir, 'store.json');
  const kernel = createSessionKernel({
    emit: () => {},
    log: () => {},
    storePath,
    createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } }),
  });
  return { dir, storePath, kernel, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a fresh store reports an empty list, not null', () => {
  // `null` would crash the sidebar's map; `[]` renders the shipped empty state.
  const run = freshKernel();
  try {
    const all = run.kernel.getAll();
    assert.ok(Array.isArray(all), 'getAll did not return an array');
    assert.equal(all.length, 0, 'a fresh store already has sessions');
  } finally { run.cleanup(); }
});

test('the first message creates a session and a transcript', async () => {
  const run = freshKernel();
  try {
    const session = run.kernel.start({ cwd: ROOT });
    await run.kernel.sendMessage(session.sessionId, 'first ever message');
    assert.equal(run.kernel.getAll().length, 1, 'the session was not registered');
    assert.ok(run.kernel.getTranscript(session.sessionId).length >= 2,
      'the first turn produced no transcript rows');
  } finally { run.cleanup(); }
});

test('the first session is persisted', async () => {
  const run = freshKernel();
  try {
    const session = run.kernel.start({ cwd: ROOT });
    await run.kernel.sendMessage(session.sessionId, 'persist me');
    run.kernel.flush();
    assert.ok(fs.existsSync(run.storePath), 'nothing was written on first run');
    const stored = JSON.parse(fs.readFileSync(run.storePath, 'utf8'));
    assert.equal((stored.sessions || []).length, 1, 'the first session did not reach the store');
  } finally { run.cleanup(); }
});

test('the shipped empty-state text still exists in the bundle', () => {
  // If upstream renamed it, the sidebar would show a blank panel rather than this sentence.
  const dir = PINNED_ION_DIST + '/assets/v1';
  assert.ok(fs.existsSync(dir), 'the shipped bundle is missing: ' + dir);
  const found = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .some((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('Sessions you start will show up here'));
  assert.equal(found, true, 'the empty-state sentence is gone from the bundle');
});
