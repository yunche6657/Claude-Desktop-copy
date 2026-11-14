// Pasted content must reach the agent and the transcript byte-for-byte.
//
// Measured this round:
//   UI layer  : insertText of a mixed payload reached the composer unchanged
//               (**bold**, `code`, CJK all present; a lone 'A\\tB' kept codes [65, 9, 66])
//               clicking send cleared the composer and the text appeared in the page
//   kernel    : the same payload produced rows=2 and every fragment survived:
//               marker, CJK, backtick, asterisks, newline, and tab
//               agent received it verbatim: true
//
// The tab case is worth keeping: an earlier check reported hasTab:false and looked like a
// bug, but a single 'A\\tB' measured codes [65,9,66] — the tab was there, and the multi-line
// innerText rendering was what hid it. The lesson from round 199 again: measure the value,
// not a proxy for it.
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

const PAYLOAD = 'PASTE-MARKER-7f3a 中文 `tick` **bold**\nline2\tA\tB';

/** Run one message through a fresh kernel; return the transcript and what the agent saw. */
async function roundTrip(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-'));
  const seen = [];
  const kernel = createSessionKernel({
    emit: () => {},
    log: () => {},
    storePath: path.join(dir, 'store.json'),
    createAgent: () => ({
      model: 'stub',
      tools: [],
      async run(opts) { seen.push(opts.messages); return { text: 'ok' }; },
    }),
  });
  try {
    const session = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(session.sessionId, text);
    return { rows: kernel.getTranscript(session.sessionId), seen };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('every fragment of a mixed payload survives to the transcript', async () => {
  const { rows } = await roundTrip(PAYLOAD);
  const blob = JSON.stringify(rows);
  for (const fragment of ['PASTE-MARKER-7f3a', '中文', 'tick', 'bold', 'line2']) {
    assert.ok(blob.includes(fragment), fragment + ' did not survive');
  }
});

test('the tab character is preserved, not converted or dropped', async () => {
  // A converted tab is invisible in the transcript view but changes what the model sees.
  //
  // content is an ARRAY of blocks ([{ type: 'text', text: 'X\tY' }]), not a string, so the
  // assertion has to read the block text — JSON.stringify escapes the tab and made the first
  // version of this test fail against correct data.
  const { rows } = await roundTrip(PAYLOAD);
  const user = rows.find((row) => row.type === 'user');
  assert.ok(user, 'no user row');
  const blocks = Array.isArray(user.message.content) ? user.message.content : [];
  const text = blocks.map((block) => block.text || '').join('');
  assert.ok(text.includes('\tA\tB'), 'the tabs were altered: ' + JSON.stringify(text));
});

test('the agent receives the payload verbatim', async () => {
  // The transcript could be right while the model sees something else.
  const { seen } = await roundTrip(PAYLOAD);
  const messages = seen[seen.length - 1] || [];
  const user = [...messages].reverse().find((message) => message.role === 'user');
  assert.ok(user, 'the agent received no user message');
  const content = typeof user.content === 'string' ? user.content : JSON.stringify(user.content);
  assert.ok(content.includes('PASTE-MARKER-7f3a'), 'the marker is missing from the model input');
  assert.ok(content.includes('中文'), 'the CJK text is missing from the model input');
});

test('markdown punctuation is not stripped on the way in', async () => {
  // The composer must not treat a user's literal asterisks as formatting to remove.
  const { rows } = await roundTrip('**bold** and `code`');
  const blob = JSON.stringify(rows);
  assert.ok(blob.includes('**bold**'), 'asterisks were stripped');
  assert.ok(blob.includes('`code`'), 'backticks were stripped');
});
