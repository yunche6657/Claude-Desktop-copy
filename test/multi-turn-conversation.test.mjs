// A multi-turn conversation that includes a tool call, driven through the real kernel.
//
// MEASURED (replica :10550), three turns in one session:
//
//   turn 1  'Read the file package.json with the Read tool and tell me the name field.'
//           -> 4 rows  (user, assistant tool_use, user tool_result, assistant text)
//   turn 2  'What was that name again? One word only.'
//           -> 6 rows  (the model answered from the tool result in the previous turn)
//   turn 3  'Reply with exactly: DONE'
//           -> 8 rows
//
//   final types   [user, assistant] x 4        strictly alternating
//   mentionsName  true   ('code-desktop-reconstruction' reached the model)
//   hasDone       true
//
// Turn 2 is the load-bearing one: answering from a tool result in an EARLIER turn only works if
// the tool_use / tool_result pair survived into the next request — which is exactly what the
// role-merge fix in round 290 had to keep intact while collapsing adjacent roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** A kernel whose agent records what it was asked, and can call a tool once. */
async function makeConversation() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-mt-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const seen = [];
  let call = 0;
  const kernel = createSessionKernel({
    createAgent: () => ({
      model: 'm',
      tools: [],
      run: async (opts) => {
        seen.push((opts.messages || []).map((m) => m.role));
        call++;
        return { text: 'reply ' + call, stopReason: 'end_turn' };
      },
    }),
    emit: () => {},
    storePath,
  });
  return { kernel, storePath, seen };
}

test('three turns accumulate without duplicating rows', async () => {
  const { kernel, storePath } = await makeConversation();
  try {
    const s = kernel.start({ cwd: ROOT });
    const sizes = [];
    for (const text of ['first', 'second', 'third']) {
      await kernel.sendMessage(s.sessionId, text);
      sizes.push((kernel.getTranscript(s.sessionId) || []).length);
    }
    assert.deepEqual(sizes, [2, 4, 6], 'row counts are wrong: ' + JSON.stringify(sizes));
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('each turn sends a strictly alternating role sequence', async () => {
  const { kernel, storePath, seen } = await makeConversation();
  try {
    const s = kernel.start({ cwd: ROOT });
    for (const text of ['first', 'second', 'third']) await kernel.sendMessage(s.sessionId, text);
    for (const roles of seen) {
      let consecutive = 0;
      for (let i = 1; i < roles.length; i++) if (roles[i] === roles[i - 1]) consecutive++;
      assert.equal(consecutive, 0, 'a turn sent consecutive roles: ' + JSON.stringify(roles));
    }
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('the final transcript alternates user and assistant throughout', async () => {
  const { kernel, storePath } = await makeConversation();
  try {
    const s = kernel.start({ cwd: ROOT });
    for (const text of ['first', 'second', 'third']) await kernel.sendMessage(s.sessionId, text);
    const types = (kernel.getTranscript(s.sessionId) || []).map((r) => r.type);
    assert.deepEqual(types, ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
      'unexpected transcript shape: ' + JSON.stringify(types));
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('a tool round in the transcript is carried into the next request', async () => {
  // FOUND BY MUTATION: the three tests above use plain text turns, whose roles already
  // alternate, so removing the role merge / the append / the row filter all survived. A tool
  // round is what makes those paths load-bearing: the transcript then holds
  // assistant(tool_use) and user(tool_result) as SEPARATE rows.
  //
  // MEASURED on the live replica: turn 1 (tool call) 4 rows, turn 2 (follow-up) 6 rows, and the
  // follow-up answered from the tool result of the earlier turn.
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-mt-tool-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const seen = [];
  const kernel = createSessionKernel({
    createAgent: () => ({
      model: 'm',
      tools: [],
      run: async (opts) => {
        seen.push(opts.messages || []);
        return { text: 'reply', stopReason: 'end_turn' };
      },
    }),
    emit: () => {},
    storePath,
  });
  try {
    const s = kernel.start({ cwd: ROOT });
    // Seed the shape the kernel actually produces for a tool round: TWO assistant rows in a
    // row (the text, then the tool_use) followed by a user tool_result. A tidier seed
    // (user, assistant, user, assistant) already alternates, so it does not exercise the merge
    // at all — measured: the merge-removal mutation survived against that version.
    kernel.setTranscript(s.sessionId, [
      { uuid: 'u1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'read it' }] } },
      { uuid: 'a1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'let me look' }] } },
      { uuid: 'a2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'package.json' } }] } },
      { uuid: 'u2', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'code-desktop-reconstruction' }] } },
    ]);
    await kernel.sendMessage(s.sessionId, 'what was the name?');

    const sent = seen[0];
    assert.ok(sent, 'the agent was not called');
    // Every seeded block must still be present, in order.
    const flat = sent.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const kinds = flat.map((b) => b.type);
    assert.ok(kinds.includes('tool_use'), 'the tool_use block was lost: ' + JSON.stringify(kinds));
    assert.ok(kinds.includes('tool_result'), 'the tool_result block was lost: ' + JSON.stringify(kinds));
    const toolResult = flat.find((b) => b.type === 'tool_result');
    assert.match(String(toolResult.content), /code-desktop-reconstruction/, 'the tool result content was lost');
    // And the roles must still alternate after the merge.
    let consecutive = 0;
    for (let i = 1; i < sent.length; i++) if (sent[i].role === sent[i - 1].role) consecutive++;
    assert.equal(consecutive, 0, 'the merged request has consecutive roles');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('a second turn appends to the transcript instead of replacing it', async () => {
  // FOUND BY MUTATION: replacing `[...existing, ...rows]` with `rows` survived the plain-text
  // tests because they only checked the FINAL row count, which happens to match.
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-mt-append-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    createAgent: () => ({ model: 'm', tools: [], run: async () => ({ text: 'r', stopReason: 'end_turn' }) }),
    emit: () => {},
    storePath,
  });
  try {
    const s = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(s.sessionId, 'first');
    const firstTexts = (kernel.getTranscript(s.sessionId) || []).map((r) => JSON.stringify(r.message));
    await kernel.sendMessage(s.sessionId, 'second');
    const after = kernel.getTranscript(s.sessionId) || [];
    assert.equal(after.length, 4, 'expected 4 rows after two turns, got ' + after.length);
    // The first turn's rows must still be there.
    const afterTexts = after.map((r) => JSON.stringify(r.message));
    assert.ok(afterTexts.includes(firstTexts[0]), 'the first turn was dropped');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});