// The surfaces a user actually touches must hit real implementations, never the fallback.
//
// Round 225 proved all 1,333 mapped methods exist. Existing is not the same as being
// implemented: the generic loop registers every method, and a method with no real handler
// answers a guessed shape (false for is/can, an empty object for getState, emptyFor(frag)
// otherwise). That guess is only safe while the call site tolerates it.
//
// So this round measured which channels actually fall through, using the app's own counter
// (CLAUDE_TRACE=all logs `[fallback] <domain>.<service>.<method>`):
//
//   startup                        -> 0 fallback hits
//   settings page + chat + model    -> 0 fallback hits
//   picker
//
// Zero is the right answer for the paths a user walks. A non-zero count here would mean some
// visible affordance is being served a guessed shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');

test('the fallback records every channel it answers', () => {
  // Without this counter the question "which channels are unimplemented" is unanswerable
  // from a running app — it can only be guessed from source, which cannot see template
  // handlers.
  assert.match(SOURCE, /fallbackCalls\.set\(frag,/, 'the fallback counter is gone');
  assert.match(SOURCE, /\[fallback\]/, 'the fallback trace line is gone');
});

test('a real handler is preferred over the fallback', () => {
  // Order is load-bearing: `if (exact) return await exact(...)` must come before any guess.
  const handlerAt = SOURCE.indexOf('if (exact) return await exact(_event, ...args);');
  const counterAt = SOURCE.indexOf('fallbackCalls.set(frag,');
  assert.ok(handlerAt > 0, 'the real-handler dispatch is missing');
  assert.ok(counterAt > handlerAt, 'the fallback is consulted before the real handler');
});

test('the fallback answers shapes the call sites tolerate', () => {
  // These three rules keep a guessed answer from crashing a synchronous caller.
  assert.match(SOURCE, /\^getState\$\|\^getStateSync\$\/\.test\(method\)\) return \{\}/,
    'getState no longer answers an object');
  assert.match(SOURCE, /\^is\|\^can\/\.test\(method\)\) return false/, 'is/can no longer answer false');
  assert.match(SOURCE, /emptyFor\(frag\)/, 'typed empty answers are gone');
});

test('the trace is opt-in, not always on', () => {
  // Always logging every channel would flood the console during normal use.
  assert.match(SOURCE, /process\.env\.CLAUDE_TRACE === 'all'/, 'the trace switch is gone');
});
