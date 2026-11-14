// Which merged entry does this capture actually produce?
// A live model is not deterministic, so "exactly one assistant entry" is asserted on a
// scripted capture; the real captures are used to prove the mapper does not lose blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCcbTranscriptMapper, frameKey, contentBlocks } = require('../desktop/ccb-events.cjs');

const FIXTURES = new URL('./fixtures/ccb-frames/', import.meta.url);
const cwd = 'C:\\work\\demo';

function capture(name) {
  const file = new URL(name + '.jsonl', FIXTURES);
  const text = fs.readFileSync(file, 'utf8');
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** A frame shaped exactly like the ones the kernel emits, for scripted expectations. */
function assistantFrame({ messageId, uuid, blocks, sessionId = 'sess-1' }) {
  return {
    type: 'assistant',
    message: { id: messageId, type: 'message', role: 'assistant', content: blocks },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
  };
}

function toolResultFrame({ uuid, toolUseId, content, isError = false, sessionId = 'sess-1' }) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
  };
}

function resultFrame({ sessionId = 'sess-1', text = 'done', numTurns = 2 }) {
  return { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: text, num_turns: numTurns, stop_reason: 'end_turn', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2 } };
}

test('one assistant message split across frames becomes ONE entry', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  const frames = [
    assistantFrame({ messageId: 'msg_A', uuid: 'u1', blocks: [{ type: 'thinking', thinking: 'hmm' }] }),
    assistantFrame({ messageId: 'msg_A', uuid: 'u2', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }] }),
    assistantFrame({ messageId: 'msg_A', uuid: 'u3', blocks: [{ type: 'text', text: 'all done' }] }),
  ];
  const events = [];
  for (const frame of frames) events.push(...mapper.apply(frame).events);

  const assistants = mapper.entries.filter((entry) => entry.type === 'assistant');
  assert.equal(assistants.length, 1, 'a message spanning frames must not become three rows');
  assert.deepEqual(assistants[0].message.content.map((block) => block.type), ['thinking', 'tool_use', 'text']);
  assert.deepEqual(events.map((event) => event.type), ['tool_request', 'text_delta']);
  assert.equal(events[0].name, 'Bash');
  assert.equal(events[1].text, 'all done');
});

test('the entries form a parentUuid chain, which is how the detail view orders them', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  mapper.apply(assistantFrame({ messageId: 'msg_A', uuid: 'u1', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }));
  mapper.apply(toolResultFrame({ uuid: 'u2', toolUseId: 'toolu_1', content: 'ok' }));
  mapper.apply(assistantFrame({ messageId: 'msg_B', uuid: 'u3', blocks: [{ type: 'text', text: 'fin' }] }));

  assert.equal(mapper.entries.length, 3);
  assert.equal(mapper.entries[0].parentUuid, null);
  assert.equal(mapper.entries[1].parentUuid, 'u1');
  assert.equal(mapper.entries[2].parentUuid, 'u2');
});

test('a tool_result is paired to its tool_use and keeps the tool name', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  mapper.apply(assistantFrame({ messageId: 'msg_A', uuid: 'u1', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'PowerShell', input: {} }] }));
  const applied = mapper.apply(toolResultFrame({ uuid: 'u2', toolUseId: 'toolu_1', content: 'PROBE_TOOL_OK' }));

  assert.equal(applied.changed.length, 1);
  const entry = applied.changed[0];
  assert.equal(entry.type, 'user');
  assert.deepEqual(entry.message.content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: 'PROBE_TOOL_OK' });
  assert.equal(applied.events[0].type, 'tool_result');
  assert.equal(applied.events[0].name, 'PowerShell', 'the result must carry the name of the tool it answers');
  assert.equal(applied.events[0].isError, false);
});

test('a failed tool result is marked as an error rather than looking like output', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  mapper.apply(assistantFrame({ messageId: 'msg_A', uuid: 'u1', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }));
  const applied = mapper.apply(toolResultFrame({ uuid: 'u2', toolUseId: 'toolu_1', content: 'Exit code 126', isError: true }));
  assert.equal(applied.changed[0].message.content[0].is_error, true);
  assert.equal(applied.events[0].isError, true);
});

test('a plain user frame is not turned into a second copy of the prompt', () => {
  // The host writes its own user entry before sending the frame; echoing it here would
  // show every prompt twice.
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  const applied = mapper.apply({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    parent_tool_use_id: null, session_id: 'sess-1', uuid: 'u0',
  });
  assert.equal(applied.changed.length, 0);
  assert.equal(mapper.entries.length, 0);
});

test('the init frame is metadata, not a conversation row', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  const applied = mapper.apply(capture('text-turn').find((frame) => frame.type === 'system'));
  assert.equal(applied.changed.length, 0);
  assert.equal(applied.events[0].type, 'meta');
  assert.ok(applied.events[0].meta.tools.includes('Bash'), 'the kernel tool list must survive');
  assert.ok(applied.events[0].meta.tools.includes('PowerShell'));
  assert.equal(applied.events[0].meta.permissionMode, 'bypassPermissions');
});

test('the result frame closes the turn and carries the usage the UI shows', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  const applied = mapper.apply(resultFrame({ text: 'DONE', numTurns: 3 }));
  assert.equal(applied.done, true);
  assert.equal(applied.summary.stopReason, 'end_turn');
  assert.equal(applied.summary.numTurns, 3);
  assert.equal(applied.summary.text, 'DONE');
  assert.equal(applied.summary.costUsd, 0.01);
  assert.equal(applied.events[0].type, 'turn_finished');
});

test('replaying the same frames twice does not duplicate rows', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  const frames = capture('tool-turn');
  for (const frame of frames) mapper.apply(frame);
  const afterFirst = mapper.entries.length;
  for (const frame of frames) mapper.apply(frame);
  assert.equal(mapper.entries.length, afterFirst, 'a replayed capture must be idempotent');
});

test('an unknown frame type is counted, not thrown', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1' });
  const applied = mapper.apply({ type: 'invented_frame_type', uuid: 'u1' });
  assert.equal(applied.unknown, true);
  assert.equal(mapper.snapshot().unknownFrames, 1);
  assert.doesNotThrow(() => mapper.apply(null));
  assert.doesNotThrow(() => mapper.apply(undefined));
});

test('the real text-turn capture maps to exactly one assistant entry and one result', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  let done = false;
  for (const frame of capture('text-turn')) if (mapper.apply(frame).done) done = true;
  assert.equal(mapper.entries.filter((entry) => entry.type === 'assistant').length, 1);
  assert.ok(done);
});

test('the real tool-turn capture keeps every block and pairs both tool results', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  const frames = capture('tool-turn');
  const toolUseIds = [];
  const toolResultIds = [];
  for (const frame of frames) {
    const applied = mapper.apply(frame);
    for (const event of applied.events) {
      if (event.type === 'tool_request') toolUseIds.push(event.id);
      if (event.type === 'tool_result') toolResultIds.push(event.id);
    }
  }
  assert.ok(toolUseIds.length >= 1, 'the capture must contain a tool round');
  assert.deepEqual(toolResultIds, toolUseIds, 'every tool_use must be answered by exactly one result');

  // No block may be lost when frames are merged: the entry's blocks must equal the sum of
  // the blocks the frames carried.
  const fromFrames = frames
    .filter((frame) => frame.type === 'assistant')
    .reduce((total, frame) => total + contentBlocks(frame.message).length, 0);
  const fromEntries = mapper.entries
    .filter((entry) => entry.type === 'assistant')
    .reduce((total, entry) => total + entry.message.content.length, 0);
  assert.equal(fromEntries, fromFrames);
});

test('two real turns produce two closed turn summaries', () => {
  const mapper = createCcbTranscriptMapper({ cwd, sessionId: 'sess-1', clock: () => '2026-10-23T00:00:00.000Z' });
  const summaries = [];
  for (const frame of capture('two-turns')) {
    const applied = mapper.apply(frame);
    if (applied.done) { summaries.push(applied.summary); mapper.resetTurn(); }
  }
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].text, 'ONE');
  assert.equal(summaries[1].text, 'TWO');
});

test('frameKey is stable for the frames that carry no uuid', () => {
  assert.equal(frameKey({ type: 'assistant', uuid: 'u1' }), 'uuid:u1');
  assert.match(frameKey({ type: 'result', session_id: 's', num_turns: 2, duration_ms: 10 }), /^result:s:2:10$/);
  assert.equal(frameKey({ type: 'assistant' }), null);
});
