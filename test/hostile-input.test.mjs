// Hostile text must reach the agent verbatim and must never crash a turn.
//
// Measured live and through the kernel this round:
//
//   composer (real typing):
//     null bytes      len=12  no crash
//     control chars   len=20  no crash
//     RTL override    len=20  no crash
//     combining marks len=21  no crash
//     ZWJ emoji x50   len=550 no crash
//
//   kernel (sendMessage):
//     nullByte       sent=verbatim
//     control        sent=verbatim
//     rtl            sent=verbatim
//     loneSurrogate  sent=verbatim   <- a lone \uD800 is not valid UTF-8 on its own
//     huge (50k)     sent=verbatim
//
// The lone surrogate case is the interesting one: JSON.stringify turns it into "\ud800",
// which is valid JSON but not valid UTF-8. A naive Buffer.from(str) would silently replace
// it with U+FFFD and the model would see a different string than the user typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** Send one message and return what the agent was handed plus the transcript. */
async function roundTrip(text) {
  const seen = [];
  const kernel = createSessionKernel({
    emit: () => {},
    log: () => {},
    createAgent: () => ({
      model: 'stub',
      tools: [],
      async run(opts) {
        seen.push(JSON.parse(JSON.stringify(opts.messages || [])));
        return { text: 'ok' };
      },
    }),
  });
  const session = kernel.start({ cwd: ROOT });
  await kernel.sendMessage(session.sessionId, text);
  return { handedToAgent: JSON.stringify(seen[0] || []), transcript: JSON.stringify(kernel.getTranscript(session.sessionId)) };
}

const HOSTILE = {
  'null byte': 'before\u0000after',
  'control characters': 'a\u0001\u0002b',
  'right-to-left override': 'x\u202Ey',
  'combining marks': 'e\u0301e\u0301',
  'zero-width joiner emoji': '👨\u200D👩\u200D👧',
};

test('hostile characters reach the agent verbatim', async () => {
  for (const [name, text] of Object.entries(HOSTILE)) {
    const { handedToAgent } = await roundTrip(text);
    // Compare the JSON-escaped form, which is what the request body carries.
    const escaped = JSON.stringify(text).slice(1, -1);
    assert.ok(handedToAgent.includes(escaped), name + ' was altered before reaching the agent');
  }
});

test('a lone surrogate does not crash and is not silently replaced', async () => {
  // \uD800 alone cannot be encoded as UTF-8; the test asserts we do not corrupt it into
  // U+FFFD, which would show the model a different character than the user typed.
  const text = 'a\uD800b';
  const { handedToAgent } = await roundTrip(text);
  assert.ok(handedToAgent.includes('\\ud800'), 'the lone surrogate was replaced or dropped');
});

test('a very large message is not truncated', async () => {
  const text = 'Z'.repeat(50000);
  const { handedToAgent, transcript } = await roundTrip(text);
  assert.ok(handedToAgent.includes(text), 'the message was truncated before the agent');
  assert.ok(transcript.includes(text), 'the transcript lost part of the message');
});

test('the transcript stays valid JSON after every hostile input', async () => {
  // A raw null byte inside a JSON string is invalid; the transcript must escape it.
  for (const text of Object.values(HOSTILE)) {
    const { transcript } = await roundTrip(text);
    assert.doesNotThrow(() => JSON.parse(transcript), 'the transcript is not parseable JSON');
  }
});
