// A failed tool call must come back as a structured error the model can act on.
//
// Measured live this round: 'Read the file does-not-exist-round-178.txt' produced
//
//   tool_result {
//     tool_use_id: 'call_00_...',
//     content: 'Tool failed [not-found]: file does not exist: <absolute path>',
//     is_error: true
//   }
//
// and the transcript kept the full four-row shape:
//   user(text) -> assistant(tool_use) -> user(tool_result) -> assistant(text)
//
// The model then said the file does not exist and offered to look for a similar name —
// it did NOT invent a first line. That is the behaviour these assertions protect: an
// unfaithful error (empty content, is_error false, or a swallowed exception) would leave
// the model with nothing to reason from, and inventing an answer becomes the only path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-path-'));
  const byName = Object.fromEntries(
    defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] }).map((t) => [t.name, t]),
  );
  return { dir, byName, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('reading a missing file reports a coded error naming the path', async () => {
  const w = workspace();
  try {
    await assert.rejects(
      () => w.byName.Read.handler({ path: path.join(w.dir, 'nope.txt') }),
      (error) => {
        assert.match(error.message, /not.?found|does not exist/i, 'the message does not say what happened');
        assert.match(error.message, /nope\.txt/, 'the message does not name the file');
        return true;
      },
    );
  } finally { w.cleanup(); }
});

test('the structured error code survives to the caller', async () => {
  // Round 154 fixed a flattening bug here: the code was being lost, so the result looked
  // like an untyped failure. The code is what lets the model distinguish 'not found' from
  // 'ambiguous match' without parsing prose.
  const w = workspace();
  try {
    try {
      await w.byName.Read.handler({ path: path.join(w.dir, 'missing.txt') });
      assert.fail('reading a missing file succeeded');
    } catch (error) {
      assert.ok(error.code, 'the error carries no code');
      assert.equal(typeof error.code, 'string');
    }
  } finally { w.cleanup(); }
});

test('a failed read never returns fabricated content', async () => {
  // The dangerous failure mode is a handler that answers "" or a placeholder: the model
  // would then describe a file that does not exist.
  const w = workspace();
  try {
    let result = null;
    try { result = await w.byName.Read.handler({ path: path.join(w.dir, 'ghost.txt') }); } catch { /* expected */ }
    assert.equal(result, null, 'the handler returned content for a file that does not exist');
  } finally { w.cleanup(); }
});

test('the executor marks a non-zero exit as an error with the code visible', async () => {
  const w = workspace();
  try {
    const r = await w.byName.Bash.handler({ command: 'git rev-parse --is-inside-work-tree' });
    assert.equal(r.isError, true);
    assert.match(String(r.content), /\[exit (?!0\])\d+/, 'the exit code is not reported');
    assert.match(String(r.content), /\[stderr\]/, 'stderr is not marked');
  } finally { w.cleanup(); }
});
