// A tool failure must tell the model WHICH failure it was.
//
// file-tools.cjs raises ToolError with a stable code (no-match, ambiguous-match,
// outside-root, invalid-match, invalid-content). createApprovalExecutor caught it and
// returned only `${error.message}`, so the distinction was lost:
//
//   measured before: 「Tool failed: oldText was not found in the file」
//   measured after:  「Tool failed [no-match]: oldText was not found in the file」
//
// The difference matters to the caller, not just to a human reading logs. 'no-match'
// means search again; 'ambiguous-match' means give more context. Flattened into one
// string the model has to guess, and a wrong guess costs an extra round trip.
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
const { createApprovalExecutor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));

/** A workspace in a temp dir, plus an executor that never prompts. */
function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolerr-'));
  const tools = defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] });
  const execute = createApprovalExecutor({
    mode: 'bypassPermissions',
    ask: async () => 'allow',
    tools,
    onEvent: () => {},
  });
  return { dir, execute, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a missing match reports the no-match code', async () => {
  const h = makeHarness();
  try {
    const f = path.join(h.dir, 'a.txt');
    fs.writeFileSync(f, 'alpha\nbeta\n', 'utf8');
    const r = await h.execute({ name: 'Edit', input: { path: f, old_string: 'gamma', new_string: 'x' } });
    assert.equal(r.isError, true, 'a failed edit must be flagged');
    assert.equal(r.errorCode, 'no-match', 'the code must survive, got ' + r.errorCode);
    assert.match(r.content, /\[no-match\]/, 'the code must be visible in the content');
    // And the file must be untouched: a refused edit must not half-apply.
    assert.equal(fs.readFileSync(f, 'utf8'), 'alpha\nbeta\n');
  } finally { h.cleanup(); }
});

test('an ambiguous match reports a different code than a missing one', async () => {
  // These two used to be indistinguishable once the code was dropped, yet they need
  // opposite corrections from the caller.
  const h = makeHarness();
  try {
    const f = path.join(h.dir, 'b.txt');
    fs.writeFileSync(f, 'same\nsame\n', 'utf8');
    const missing = await h.execute({ name: 'Edit', input: { path: f, old_string: 'nope', new_string: 'x' } });
    const ambiguous = await h.execute({ name: 'Edit', input: { path: f, old_string: 'same', new_string: 'x' } });
    assert.equal(missing.errorCode, 'no-match');
    assert.equal(ambiguous.errorCode, 'ambiguous-match');
    assert.notEqual(missing.content, ambiguous.content, 'the two failures must read differently');
    assert.equal(fs.readFileSync(f, 'utf8'), 'same\nsame\n', 'neither attempt may modify the file');
  } finally { h.cleanup(); }
});

test('writing outside the approved roots is refused with a code', async () => {
  // The one failure mode with a security consequence: it must never be silent.
  const h = makeHarness();
  try {
    const target = process.platform === 'win32' ? 'C:\\Windows\\System32\\nope.txt' : '/etc/nope.txt';
    const r = await h.execute({ name: 'Write', input: { path: target, content: 'x' } });
    assert.equal(r.isError, true, 'an out-of-root write must fail');
    assert.ok(r.errorCode, 'the refusal must carry a code');
    assert.match(r.content, /outside the approved roots/, 'the reason must be stated');
  } finally { h.cleanup(); }
});
