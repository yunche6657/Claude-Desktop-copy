// Long and unusual user input must survive every layer we own.
//
// Verified live this round (real pointer + CDP input):
//
//   multiline paste with 中文 + emoji + ``` fences -> accepted intact
//   20,000-character paste -> 20,073 chars typed, Send still enabled, no crash
//   draft survives a reload -> localStorage composer-draft:epitaxy-draft
//
// The draft needs no test from us (it lives wholly in the shipped bundle). What DOES need
// pinning is our own path: the kernel must carry a huge message to the agent unchanged, and
// the transcript must hold it. A silent truncation there would look like the model ignoring
// the end of a pasted log — a support ticket nobody could diagnose from the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** A kernel whose agent records exactly what it was handed. */
function makeKernel() {
  const seen = [];
  const kernel = createSessionKernel({
    emit: () => {},
    log: () => {},
    createAgent: () => ({
      model: 'stub',
      tools: [],
      async run(opts) {
        seen.push(opts.messages || []);
        return { text: 'ok', stopReason: 'end_turn' };
      },
    }),
  });
  return { kernel, seen };
}

test('a 20k-character message reaches the agent intact', () => {
  // The live test typed 20,073 characters into the composer. If any layer between the box
  // and the model truncated it, the user would see a reply that ignored the tail.
  const big = 'A'.repeat(20000);
  const { kernel, seen } = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  return kernel.sendMessage(s.sessionId, big).then(() => {
    assert.equal(seen.length, 1, 'the agent was not called');
    const sent = JSON.stringify(seen[0]);
    assert.ok(sent.includes(big), 'the message was truncated or altered before the agent');
  });
});

test('the transcript keeps the whole long message', () => {
  // getTranscript is what the conversation view renders on reopen.
  const big = 'B'.repeat(20000);
  const { kernel } = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  return kernel.sendMessage(s.sessionId, big).then(() => {
    const text = JSON.stringify(kernel.getTranscript(s.sessionId));
    assert.ok(text.includes(big), 'the transcript lost part of the message');
  });
});

test('unicode and emoji survive the round trip', () => {
  // 中文 plus astral-plane emoji: a byte-length slice would cut a surrogate pair in half.
  const tricky = '前缀 🚀 中间 🎯 后缀 —— “引号” \u00e9';
  const { kernel, seen } = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  return kernel.sendMessage(s.sessionId, tricky).then(() => {
    assert.ok(JSON.stringify(seen[0]).includes(tricky), 'the agent received mangled unicode');
    assert.ok(JSON.stringify(kernel.getTranscript(s.sessionId)).includes(tricky), 'the transcript mangled unicode');
  });
});
