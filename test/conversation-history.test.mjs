// Core conversation behaviour, verified live with real pointer input this round.
//
//   turn 1: "Remember this number: 4173. Reply with just OK."   -> OK
//   turn 2: "What number did I ask you to remember?"            -> 4173
//   restart, reopen: 4 transcript rows, 4173 still there, title and mode intact
//
// So the history is really passed to the model and really persisted. Nothing in the
// suite covered that end to end: kernel tests use stub agents, and the transcript tests
// feed fixture frames. A regression that dropped history, or persisted nothing, would
// have left every test green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** A stub agent that records exactly what history each turn received. */
function makeKernel() {
  const seen = [];
  let turn = 0;
  const kernel = createSessionKernel({
    emit: () => {},
    log: () => {},
    createAgent: () => ({
      model: 'stub',
      tools: [],
      async run(opts) {
        seen.push({ turn: ++turn, messages: JSON.parse(JSON.stringify(opts.messages || [])) });
        return { text: 'reply-' + turn, stopReason: 'end_turn' };
      },
    }),
  });
  return { kernel, seen };
}

test('the second turn is given the first turn as history', () => {
  // The whole point of a conversation. Asserting on the messages array the agent
  // receives is the only place this is observable without a live model.
  const { kernel, seen } = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  return kernel.sendMessage(s.sessionId, 'Remember this number: 4173. Reply with just OK.').then(() =>
    kernel.sendMessage(s.sessionId, 'What number did I ask you to remember?')).then(() => {
      assert.equal(seen.length, 2, 'expected exactly two turns');
      const second = seen[1].messages;
      const joined = JSON.stringify(second);
      assert.ok(joined.includes('4173'), 'the second turn was not given the first user message');
      assert.ok(joined.includes('reply-1'), 'the second turn was not given the first assistant reply');
    });
});

test('the transcript keeps every row of both turns', () => {
  // Four rows: user, assistant, user, assistant. A dropped row would still render a
  // plausible conversation, so the count matters as much as the content.
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  return kernel.sendMessage(s.sessionId, 'first').then(() =>
    kernel.sendMessage(s.sessionId, 'second')).then(() => {
      const rows = kernel.getTranscript(s.sessionId);
      assert.equal(rows.length, 4, 'expected user/assistant/user/assistant, got ' + rows.length);
      const text = JSON.stringify(rows);
      assert.ok(text.includes('first'), 'the first user message is missing');
      assert.ok(text.includes('second'), 'the second user message is missing');
    });
});

test('a kernel reopened on the same store sees the persisted sessions', () => {
  // This is what a restart does: flush, drop everything, construct again from the same
  // file. The first version of this test built a kernel with no storePath at all and
  // then only asserted that a transcript array existed — it would have passed even with
  // persistence completely broken.
  const storePath = path.join(ROOT, '.tmp', 'relaunch-store.json');
  try { fs.unlinkSync(storePath); } catch { /* first run */ }
  const stub = () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } });
  const first = createSessionKernel({ emit: () => {}, log: () => {}, storePath, createAgent: stub });
  const s = first.start({ cwd: process.cwd() });
  const before = first.getAll().length;
  first.flush();
  const second = createSessionKernel({ emit: () => {}, log: () => {}, storePath, createAgent: stub });
  const after = second.getAll();
  assert.ok(fs.existsSync(storePath), 'flush wrote no store file');
  assert.equal(after.length, before, 'the reopened kernel did not load the stored sessions');
  assert.ok(after.some((row) => row.sessionId === s.sessionId), 'the session id did not survive');
  try { fs.unlinkSync(storePath); } catch { /* best effort */ }
});
