// A malformed transcript ROW must not make the session unusable.
//
// FOUND BROKEN, THEN FIXED. The store file could load fine while a row inside it was garbage,
// and the failure only appeared when the user tried to send — the worst moment.
//
//   before: a transcript of [null]  ->  sendMessage threw
//           'Cannot read properties of null (reading message)'  (session-kernel.cjs:520)
//           and a mixed [valid, null, valid] transcript failed the same way.
//
// Two separate unguarded reads, both fixed:
//   1. building the history mapped over every row and read `e.message` — null rows threw.
//      Now unusable rows are filtered out before mapping.
//   2. deriving the parent uuid read `existing[len-1].uuid` and `last.uuid` — null rows threw.
//      Now both fall back to null, which the transcript treats as a root.
//
// MEASURED after the fix: all seven malformed-row shapes can send a message:
//   row is null / a string / has no message / message has no content
//   content is a string / content has a null block / mixed valid and broken
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const CASES = [
  ['a null row', [null]],
  ['a string row', ['just a string']],
  ['a row with no message', [{ uuid: 'u1', type: 'user' }]],
  ['a message with no content', [{ uuid: 'u1', type: 'user', message: { role: 'user' } }]],
  ['string content', [{ uuid: 'u1', type: 'user', message: { role: 'user', content: 'plain' } }]],
  ['a null block', [{ uuid: 'u1', type: 'user', message: { role: 'user', content: [null] } }]],
  ['mixed valid and broken', [
    { uuid: 'u1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ok' }] } },
    null,
    { uuid: 'u2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fine' }] } },
  ]],
];

/** Load a kernel whose store holds the given rows, then try to send. */
async function sendWithRows(rows) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-rows-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(storePath, JSON.stringify({
    sessions: [{ sessionId: 'local_t', cwd: ROOT, title: 't', createdAt: 1, updatedAt: 1 }],
    transcripts: { local_t: rows },
  }), 'utf8');
  try {
    const kernel = createSessionKernel({
      createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'ok', stopReason: 'end_turn' }) }),
      emit: () => {},
      storePath,
    });
    return await kernel.sendMessage('local_t', 'next');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
}

for (const [label, rows] of CASES) {
  test(`a session survives ${label} in its transcript`, async () => {
    let result;
    await assert.doesNotReject(async () => { result = await sendWithRows(rows); }, 'a malformed row crashed the send');
    assert.equal(result.ok, true, 'the send was refused: ' + JSON.stringify(result && result.error));
  });
}

test('valid rows around a broken one still contribute to the history', async () => {
  // The filter must drop only the unusable rows, not the whole transcript.
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-rows-keep-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const captured = [];
  fs.writeFileSync(storePath, JSON.stringify({
    sessions: [{ sessionId: 'local_t', cwd: ROOT, title: 't', createdAt: 1, updatedAt: 1 }],
    transcripts: { local_t: [
      { uuid: 'u1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      null,
      { uuid: 'u2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    ] },
  }), 'utf8');
  try {
    const kernel = createSessionKernel({
      createAgent: () => ({
        model: 'm',
        tools: [],
        run: async (opts) => { captured.push((opts.messages || []).length); return { text: 'ok', stopReason: 'end_turn' }; },
      }),
      emit: () => {},
      storePath,
    });
    await kernel.sendMessage('local_t', 'next');
    // Two valid prior rows plus the new message.
    assert.equal(captured[0], 3, 'the valid rows were not carried into the history: ' + captured[0]);
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

// ---- one layer deeper: a malformed BLOCK inside a valid row ----
//
// MEASURED: all eight shapes below still allow the session to send. The kernel passes blocks
// through to the model without parsing them, so a bad block costs that one block, not the
// conversation. This is the bottom of the 'state' checklist: file -> record -> row -> block.
const BLOCK_CASES = [
  ['a null block', [{ type: 'text', text: 'ok' }, null]],
  ['a string block', [{ type: 'text', text: 'ok' }, 'stray']],
  ['a block with no type', [{ text: 'no type' }]],
  ['a text block with no text', [{ type: 'text' }]],
  ['a tool_use with no id', [{ type: 'tool_use', name: 'Read', input: {} }]],
  ['a tool_use with no name', [{ type: 'tool_use', id: 't1', input: {} }]],
  ['a tool_result with no id', [{ type: 'tool_result', content: 'x' }]],
  ['an unknown block type', [{ type: 'mystery', payload: 1 }]],
];

/** Load a kernel whose single row holds the given blocks, then try to send. */
async function sendWithBlocks(blocks) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-blocks-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(storePath, JSON.stringify({
    sessions: [{ sessionId: 'local_b', cwd: ROOT, title: 'b', createdAt: 1, updatedAt: 1 }],
    transcripts: { local_b: [{ uuid: 'u1', type: 'assistant', message: { role: 'assistant', content: blocks } }] },
  }), 'utf8');
  try {
    const kernel = createSessionKernel({
      createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'ok', stopReason: 'end_turn' }) }),
      emit: () => {},
      storePath,
    });
    return await kernel.sendMessage('local_b', 'next');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
}

for (const [label, blocks] of BLOCK_CASES) {
  test(`a session survives ${label}`, async () => {
    let result;
    await assert.doesNotReject(async () => { result = await sendWithBlocks(blocks); }, 'a malformed block crashed the send');
    assert.equal(result.ok, true, 'the send was refused: ' + JSON.stringify(result && result.error));
  });
}
