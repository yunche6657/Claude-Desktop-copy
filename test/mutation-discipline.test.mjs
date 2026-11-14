// A mutation harness must target one statement, not one string.
//
// Round 152 ended with the rule "write a mutation that turns the test red before
// trusting it". This round applied it to cancel-stuck-turn.test.mjs and got a
// FALSE ALARM twice in a row:
//
//   first attempt  -> replaced the first `record(sessionId, { isRunning: false })`
//                     (the catch branch of sendMessage) — tests stayed green
//   second attempt -> replaced line 709 — tests stayed green again
//
// Both times the conclusion looked like "the test cannot fail", which would have
// meant deleting a test that actually works. The real cause: the file contains that
// exact statement TWICE, in two different functions, and only the one inside cancel()
// is what the test exercises. Mutating line 805 turned two tests red immediately.
//
// So the harness below pins MUTATION DISCIPLINE itself: any mutation must be located
// by its enclosing function, and a mutation that changes no test outcome must be
// reported as a mistake rather than accepted as proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');

/** Line numbers (1-based) of every exact statement match. */
function findStatements(source, statement) {
  const hits = [];
  source.split('\n').forEach((line, i) => {
    if (line.trim() === statement) hits.push(i + 1);
  });
  return hits;
}

/** The nearest enclosing function name above a 1-based line number. */
function ownerOf(source, lineNumber) {
  const lines = source.split('\n');
  for (let i = lineNumber - 1; i >= 0 && i > lineNumber - 200; i -= 1) {
    const m = lines[i].match(/^\s*(?:async )?function ([A-Za-z_$][\w$]*)/);
    if (m) return m[1];
  }
  return null;
}

test('the same statement appears in more than one function, so string search is unsafe', () => {
  // This is the concrete trap. If the statement ever becomes unique the test should be
  // revisited rather than silently kept.
  const hits = findStatements(KERNEL, 'record(sessionId, { isRunning: false });');
  assert.ok(hits.length >= 2, 'expected the statement in at least two places, found ' + hits.length);
  const owners = hits.map((n) => ownerOf(KERNEL, n));
  assert.equal(owners.includes('cancel'), true, 'no occurrence sits inside cancel()');
  // And the other one must be somewhere else — that is what makes search ambiguous.
  assert.equal(new Set(owners).size >= 2, true, 'all occurrences share one owner: ' + JSON.stringify(owners));
});

test('the cancel path still clears isRunning, located by function not by string', () => {
  // Anchor the assertion on cancel()'s own body so a future edit elsewhere cannot make
  // this pass while the cancel path regresses.
  const hits = findStatements(KERNEL, 'record(sessionId, { isRunning: false });');
  const inCancel = hits.filter((n) => ownerOf(KERNEL, n) === 'cancel');
  assert.equal(inCancel.length, 1, 'cancel() must clear isRunning exactly once');
  // Located by the declaration, not by its exact text: the signature legitimately gained an
  // optional second parameter (R385's keepHeldInput). An exact-string anchor silently stopped
  // matching and reported "cancel() lost its isRunning clear" — a false alarm that named the
  // wrong cause.
  //
  // The body is delimited by indentation and line splitting rather than by '\n  }\n': this
  // checkout is CRLF, so a '\n'-only terminator never matches. Both "not found" cases assert
  // explicitly instead of degrading into an empty slice that would pass every substring check.
  const lines = KERNEL.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}function cancel\(sessionId[,)]/.test(line));
  assert.notEqual(start, -1, 'cancel() is no longer declared at two-space indentation');
  const end = lines.findIndex((line, i) => i > start && /^ {2}\}$/.test(line));
  assert.notEqual(end, -1, 'cancel() body has no closing brace at the expected indentation');
  const body = lines.slice(start, end + 1).join('\n');
  assert.ok(body.includes('record(sessionId, { isRunning: false });'), 'cancel() lost its isRunning clear');
  assert.ok(body.includes('running.delete(sessionId);'), 'cancel() lost its running-map cleanup');
});
