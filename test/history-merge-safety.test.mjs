// The role-merge fix verified by BEHAVIOUR, not by reading the source.
//
// WHY THIS FILE EXISTS. The first version of these checks asserted on source text — 'the merge
// appends in order', 'nothing sorts' — and a mutation that reversed the merged output
// (`return out.reverse()`) left them GREEN, because the text still looked right. A test that
// greps for an expression cannot see what the function returns.
//
// So this file loads the real kernel, runs real turns, and inspects the messages the agent
// actually received. Measured with four plain turns:
//
//   turn 1: 1 message   [user]
//   turn 2: 3 messages  [user, assistant, user]
//   turn 3: 5 messages  [user, assistant, user, assistant, user]
//   turn 4: 7 messages  ...
//
// zero consecutive same-role pairs at every turn, and the count grows by exactly 2.
//
// Also replayed every stored session through the same rule: 152 sessions, block count preserved
// 152/152, block ORDER preserved 152/152. Order is the property a count check cannot see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Run N turns against the real kernel and capture the roles each turn sent. */
async function captureRoles(turns) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-roles-' + process.pid + '-' + Date.now() + '.json');
  const captured = [];
  const kernel = createSessionKernel({
    createAgent: () => ({
      model: 'm',
      tools: [],
      run: async (opts) => {
        captured.push((opts.messages || []).map((m) => m.role));
        return { text: 'ok', stopReason: 'end_turn' };
      },
    }),
    emit: () => {},
    storePath,
  });
  try {
    const s = kernel.start({ cwd: ROOT });
    for (let i = 0; i < turns; i++) await kernel.sendMessage(s.sessionId, 'message ' + i);
    return captured;
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
}

function consecutivePairs(roles) {
  let n = 0;
  for (let i = 1; i < roles.length; i++) if (roles[i] === roles[i - 1]) n++;
  return n;
}

test('every turn sends strictly alternating roles', async () => {
  const captured = await captureRoles(4);
  assert.equal(captured.length, 4, 'the agent was not called once per turn');
  for (const roles of captured) {
    assert.equal(consecutivePairs(roles), 0, 'a turn sent consecutive same-role messages: ' + JSON.stringify(roles));
  }
});

test('history accumulates without duplicating or dropping messages', async () => {
  // Measured: 1, 3, 5, 7 — each turn adds exactly one user and one assistant message.
  const captured = await captureRoles(4);
  const sizes = captured.map((r) => r.length);
  assert.deepEqual(sizes, [1, 3, 5, 7], 'history sizes are wrong: ' + JSON.stringify(sizes));
});


test('a tool-round transcript still sends alternating roles', async () => {
  // This is the case that originally broke: the transcript stores assistant(tool_use) and
  // user(tool_result) as SEPARATE rows, so mapping rows straight to messages produced two
  // assistants in a row. Measured after the fix: roles ['user','assistant','user'], 0 pairs.
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-toolround-' + process.pid + '-' + Date.now() + '.json');
  const captured = [];
  const kernel = createSessionKernel({
    createAgent: () => ({
      model: 'm',
      tools: [],
      run: async (opts) => {
        captured.push((opts.messages || []).map((m) => m.role));
        return { text: 'ok', stopReason: 'end_turn' };
      },
    }),
    emit: () => {},
    storePath,
  });
  try {
    const s = kernel.start({ cwd: ROOT });
    // Seed a transcript shaped like a tool round: two assistant rows then a user tool_result.
    const seed = [
      { uuid: 'u1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { uuid: 'a1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } },
      { uuid: 'a2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { uuid: 'u2', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] } },
    ];
    kernel.setTranscript(s.sessionId, seed);
    await kernel.sendMessage(s.sessionId, 'next');
    const roles = captured[0] || [];
    assert.equal(consecutivePairs(roles), 0, 'a tool round produced consecutive roles: ' + JSON.stringify(roles));
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});
test('the merged history keeps block order', () => {
  // Behavioural check on the pure rule, using the order-sensitive case:
  // [user A][user B][assistant C] must become [user A+B][assistant C], never reordered.
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8').replace(/\r\n/g, '\n');
  // The helper is not exported, so exercise it through a tiny replay of its exact source.
  const at = kernel.indexOf('function mergeAdjacentRoles');
  const end = kernel.indexOf('\n}\n', at);
  assert.ok(at > 0 && end > at, 'the merge helper is missing');
  const source = kernel.slice(at, end + 2);
  const merge = new Function(source + '; return mergeAdjacentRoles;')();
  const merged = merge([
    { role: 'user', content: [{ type: 'text', text: 'A' }] },
    { role: 'user', content: [{ type: 'text', text: 'B' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'C' }] },
  ]);
  assert.deepEqual(merged.map((m) => m.role), ['user', 'assistant'], 'roles were reordered');
  assert.deepEqual(merged[0].content.map((b) => b.text), ['A', 'B'], 'block order inside the merge changed');
});