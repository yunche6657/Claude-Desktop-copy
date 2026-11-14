// An imported CLI session must render the whole conversation, not just its first line.
//
// The renderer does not lay messages out by array order: it walks `parentUuid` from the
// head to build the tree. The CLI import path dropped that field, so every imported row
// was an orphan and the session opened showing only the first user message — measured on
// the live replica: 4 rows in the store, 1 rendered.
//
// Keeping the field is necessary but not sufficient: a CLI file interleaves rows we keep
// with rows we filter out (queue-operation, attribution-snapshot, sidechain traffic), so a
// kept row can point at a parent that is not in the kept set. Measured: 141 of 478 rows.
// Those parents must be repaired, or the rows stay unreachable anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readCliTranscript } = require(path.join(ROOT, 'desktop', 'cli-transcript.cjs'));

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clitx-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join(String.fromCharCode(10)), 'utf8');
  return file;
}

const userRow = (uuid, text, parentUuid) => ({
  type: 'user', uuid, parentUuid, timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistantRow = (uuid, text, parentUuid) => ({
  type: 'assistant', uuid, parentUuid, timestamp: '2026-01-01T00:00:01.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

test('the parent chain survives the import', () => {
  const file = writeTranscript([
    userRow('a', 'one', null),
    assistantRow('b', 'two', 'a'),
    userRow('c', 'three', 'b'),
  ]);
  const rows = readCliTranscript(file);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].parentUuid, null, 'the head has no parent');
  assert.equal(rows[1].parentUuid, 'a');
  assert.equal(rows[2].parentUuid, 'b');
});

test('every row is reachable from the head', () => {
  const file = writeTranscript([
    userRow('a', 'one', null),
    assistantRow('b', 'two', 'a'),
    userRow('c', 'three', 'b'),
    assistantRow('d', 'four', 'c'),
  ]);
  const rows = readCliTranscript(file);
  const kept = new Set(rows.map((row) => row.uuid));
  for (const row of rows.slice(1)) {
    assert.ok(kept.has(row.parentUuid), 'row ' + row.uuid + ' points outside the kept set');
  }
});

test('a parent that was filtered out is repaired, not left dangling', () => {
  const file = writeTranscript([
    userRow('a', 'one', null),
    { type: 'queue-operation', uuid: 'dropped', parentUuid: 'a' },
    assistantRow('b', 'two', 'dropped'),
  ]);
  const rows = readCliTranscript(file);
  assert.equal(rows.length, 2, 'the unkept row is still filtered out');
  assert.equal(rows[1].parentUuid, 'a', 'it hangs off the previous kept row instead');
});

test('a row with no parentUuid at all hangs off its predecessor', () => {
  const file = writeTranscript([
    userRow('a', 'one', null),
    { type: 'assistant', uuid: 'b', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
  ]);
  const rows = readCliTranscript(file);
  assert.equal(rows[1].parentUuid, 'a');
});

test('noise rows still never become messages', () => {
  const file = writeTranscript([
    { type: 'attribution-snapshot', uuid: 'n1', message: { content: [] } },
    userRow('a', 'one', null),
    { type: 'queue-operation', uuid: 'n2' },
  ]);
  const rows = readCliTranscript(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uuid, 'a');
});

test('an unreadable file answers an empty array instead of throwing', () => {
  assert.deepEqual(readCliTranscript(path.join(os.tmpdir(), 'definitely-not-here.jsonl')), []);
});
test('the real parent is kept even when it is not the previous row', () => {
  // The distinguishing case. A transcript can branch: the next row may hang off an
  // earlier message rather than the one above it (an edited turn, a retry, a sidechain
  // rejoining). Falling back to "link to the previous row" reproduces reading order but
  // loses that structure, so this asserts the claimed parent wins when it is kept.
  const file = writeTranscript([
    userRow('a', 'root', null),
    assistantRow('b', 'branch one', 'a'),
    assistantRow('c', 'branch two', 'a'),
  ]);
  const rows = readCliTranscript(file);
  assert.equal(rows[1].parentUuid, 'a');
  assert.equal(rows[2].parentUuid, 'a', 'c hangs off a, not off the row above it');
  assert.notEqual(rows[2].parentUuid, 'b');
});

test('a branch off the head stays a branch', () => {
  const file = writeTranscript([
    userRow('a', 'root', null),
    assistantRow('b', 'one', 'a'),
    assistantRow('c', 'two', 'a'),
    assistantRow('d', 'three', 'c'),
  ]);
  const rows = readCliTranscript(file);
  const byId = new Map(rows.map((row) => [row.uuid, row]));
  assert.equal(byId.get('c').parentUuid, 'a');
  assert.equal(byId.get('d').parentUuid, 'c');
  // b and c share a parent, and d continues c: that shape must survive.
  assert.equal(byId.get('b').parentUuid, byId.get('c').parentUuid);
});
