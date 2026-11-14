// A session interrupted by a crash must come back usable, not stuck.
//
// Measured this round:
//   before crash: isRunning = true
//   after reload: exists = true | isRunning = false
//   continue after restart: ok
//
// and every user-set field survives a reload:
//   title kept-title / isStarred true / isArchived false / permissionMode auto / model ...
//   archiving then reloading still reports isArchived true
//
// The stuck case is the one worth guarding: if a persisted record kept isRunning=true, the
// kernel would refuse every later message with "a turn is already running" and the user
// would have no way out except deleting the session.
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

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-state-'));
  return { dir, storePath: path.join(dir, 'store.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Build a kernel bound to one store; `delay` controls how long a turn takes. */
function kernelAt(storePath, delay = 0) {
  return createSessionKernel({
    emit: () => {},
    log: () => {},
    storePath,
    createAgent: () => ({
      model: 'stub',
      tools: [],
      run: () => new Promise((resolve) => setTimeout(() => resolve({ text: 'ok' }), delay)),
    }),
  });
}

test('a running session is never persisted as running', async () => {
  // Two independent protections exist and this asserts the FIRST one: the writer does not
  // put isRunning:true on disk at all. Mutating the load-time reset therefore did not make
  // any test fail — the persisted value was already false, which is why this is checked here
  // explicitly rather than inferred from a reload.
  const { dir, storePath, cleanup } = tempStore();
  try {
    const first = kernelAt(storePath, 10000);
    const session = first.start({ cwd: ROOT });
    first.sendMessage(session.sessionId, 'interrupted').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(first.getSession(session.sessionId).isRunning, true, 'the turn should be running');
    first.flush();

    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const record = (onDisk.sessions || []).find((row) => row.sessionId === session.sessionId);
    assert.ok(record, 'the session was not persisted');
    assert.equal(record.isRunning, false, 'a running turn was written to disk as running');
  } finally { cleanup(); }
});

test('a session interrupted mid-turn reloads as idle', async () => {
  // The second protection: even if a store were written by an older build with isRunning:true,
  // loading forces it false. This is what keeps a crashed session usable.
  const { dir, storePath, cleanup } = tempStore();
  try {
    const first = kernelAt(storePath, 10000);
    const session = first.start({ cwd: ROOT });
    first.sendMessage(session.sessionId, 'interrupted').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    first.flush();

    // Simulate a store written by a build that did persist the flag.
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    for (const row of raw.sessions || []) row.isRunning = true;
    fs.writeFileSync(storePath, JSON.stringify(raw, null, 2));

    const reloaded = kernelAt(storePath, 40).getSession(session.sessionId);
    assert.ok(reloaded, 'the session did not survive the reload');
    assert.equal(reloaded.isRunning, false, 'a reloaded session still looks busy');
  } finally { cleanup(); }
});

test('a reloaded session can accept a new message', async () => {
  // The user-visible consequence of the previous test: they must be able to keep working.
  const { dir, storePath, cleanup } = tempStore();
  try {
    const first = kernelAt(storePath, 10000);
    const session = first.start({ cwd: ROOT });
    first.sendMessage(session.sessionId, 'interrupted').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    first.flush();

    const second = kernelAt(storePath, 20);
    await second.sendMessage(session.sessionId, 'after restart');
    const text = JSON.stringify(second.getTranscript(session.sessionId));
    assert.ok(text.includes('after restart'), 'the reloaded session refused to run');
  } finally { cleanup(); }
});

test('user-set session fields survive a reload', async () => {
  const { dir, storePath, cleanup } = tempStore();
  try {
    const first = kernelAt(storePath);
    const session = first.start({ cwd: ROOT });
    first.update(session.sessionId, {
      title: 'kept-title',
      isStarred: true,
      isArchived: false,
      permissionMode: 'auto',
      model: 'deepseek-v4.1-flash',
    });
    first.flush();

    const reloaded = kernelAt(storePath).getSession(session.sessionId);
    assert.equal(reloaded.title, 'kept-title');
    assert.equal(reloaded.isStarred, true);
    assert.equal(reloaded.isArchived, false);
    assert.equal(reloaded.permissionMode, 'auto');
    assert.equal(reloaded.model, 'deepseek-v4.1-flash');
  } finally { cleanup(); }
});

test('archiving survives a reload', async () => {
  // Otherwise archived sessions silently reappear in the active list.
  const { dir, storePath, cleanup } = tempStore();
  try {
    const first = kernelAt(storePath);
    const session = first.start({ cwd: ROOT });
    first.update(session.sessionId, { isArchived: true });
    first.flush();
    assert.equal(kernelAt(storePath).getSession(session.sessionId).isArchived, true);
  } finally { cleanup(); }
});
