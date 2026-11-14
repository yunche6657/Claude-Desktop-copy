// A mutation runner must distinguish three outcomes, not two.
//
// WHY. While mutation-testing this project I twice read a GREEN that was not green:
//
//   1. the mutation had not applied at all (fixed by asserting out !== before), and
//   2. the test HUNG until the runner killed it, so it printed no `fail N` line and the
//      regex counted zero failures.
//
// Case 2 is the dangerous one because it looks exactly like success. tools/mutation-outcome.mjs
// now returns 'red' | 'hung' | 'green', and mutationCaught() counts BOTH red and hung as caught.
//
// MEASURED by calling the helper directly from a shell:
//   a passing file             -> { outcome: 'green', fails: 0, passes: 5 }
//   a file that does not exist -> { outcome: 'hung', fails: null }   (no summary produced)
//
// SCOPE NOTE. This file does NOT spawn the runner itself. Running `node --test` from inside
// `node --test` is unreliable on this host — the inner run reports no summary, which would make
// these assertions flaky for a reason unrelated to the helper. The spawning behaviour is
// covered by classify() below, which is the part that actually decides the outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// pathToFileURL, not a bare path: on Windows an absolute path is not a valid ESM URL scheme.
const helper = await import(pathToFileURL(path.join(ROOT, 'tools', 'mutation-outcome.mjs')).href);

test('a summary reporting zero failures is green', () => {
  const result = helper.classify({ stdout: 'ℹ tests 5\nℹ pass 5\nℹ fail 0\n', signal: null, status: 0 });
  assert.equal(result.outcome, 'green', JSON.stringify(result));
  assert.equal(result.fails, 0);
  assert.equal(result.passes, 5);
});

test('a summary reporting failures is red', () => {
  const result = helper.classify({ stdout: 'ℹ pass 3\nℹ fail 2\n', signal: null, status: 1 });
  assert.equal(result.outcome, 'red', JSON.stringify(result));
  assert.equal(result.fails, 2);
});

test('a run with no summary is hung, not green', () => {
  // The exact failure mode that produced a false GREEN during mutation testing.
  const result = helper.classify({ stdout: '', stderr: '', signal: null, status: 0 });
  assert.equal(result.outcome, 'hung', 'a missing summary was treated as a pass: ' + JSON.stringify(result));
  assert.equal(result.fails, null);
});

test('a killed runner is hung even if it printed a partial summary', () => {
  const result = helper.classify({ stdout: 'ℹ pass 2\n', stderr: '', signal: 'SIGTERM', status: null });
  assert.equal(result.outcome, 'hung', JSON.stringify(result));
});

test('mutationCaught counts hung as caught', () => {
  // If this returned false for 'hung', a mutation that hangs the suite would look survived.
  assert.equal(helper.mutationCaught({ outcome: 'hung' }), true);
  assert.equal(helper.mutationCaught({ outcome: 'red' }), true);
  assert.equal(helper.mutationCaught({ outcome: 'green' }), false);
});
