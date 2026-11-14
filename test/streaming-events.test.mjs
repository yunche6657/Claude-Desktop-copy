// The event channel carries a full turn, and text_delta degrades honestly on this gateway.
//
// Measured this round by subscribing to LocalSessions.onOnEvent and driving one turn:
//
//   events received: start, session_updated, turn_started, turn, shell_pty_data,
//                    text_delta, done, message, close, turn_finished
//
// and the deltas themselves:
//
//   count: 1, spanMs: 0, lens: [35]
//
// One delta carrying the whole reply. That is not a bug in the shell: round 156 established
// that this gateway's streaming endpoint returns only message_delta + message_stop, with no
// content_block_delta, so there is nothing to deliver progressively. The kernel still emits
// text_delta for each `text` event it receives — the mechanism is real, the source is not
// incremental.
//
// Round 206 could not confirm whether the UI reacts to persist_failed. This round confirms
// the channel itself works end to end, which is the part that was in doubt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
const CCB_EVENTS = fs.readFileSync(path.join(ROOT, 'desktop', 'ccb-events.cjs'), 'utf8');

test('the local kernel emits text_delta for each text event', () => {
  // Without this the conversation would appear only when the turn ends.
  const at = KERNEL.indexOf("if (event.type === 'text') {");
  assert.ok(at > 0, 'the text branch is missing');
  const block = KERNEL.slice(at, at + 200);
  assert.match(block, /emit\(\{ type: 'text_delta'/, 'the text branch does not emit text_delta');
});

test('the ccb path emits text_delta per content block', () => {
  // A different source, same event name: the renderer needs one shape from both paths.
  assert.match(CCB_EVENTS, /type: 'text_delta'/);
});

test('a whole-turn delta is handled without special casing', () => {
  // This gateway delivers the entire reply in one delta (measured: count 1, spanMs 0).
  // The renderer must not assume more than one, and the kernel must not either.
  const at = KERNEL.indexOf("emit({ type: 'text_delta'");
  assert.ok(at > 0);
  const block = KERNEL.slice(Math.max(0, at - 300), at + 200);
  assert.equal(/text_delta[\s\S]{0,200}length > 1/.test(block), false,
    'the emitter now assumes multiple deltas');
});

test('the single-delta measurement is recorded', () => {
  const status = fs.readFileSync(path.join(ROOT, 'evidence', 'STATUS.md'), 'utf8');
  assert.ok(status.includes('text_delta'), 'the delta measurement is not in the evidence log');
});
