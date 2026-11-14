// A tool error must tell the caller what to do next, not just what went wrong.
//
// Round 214 fixed one message that leaked an internal name. This round checks the other half
// of the same property: actionability. Measured before the change, 21 error messages existed
// and only 4 suggested a next step. The three most common ones were bare statements:
//
//   file does not exist: <path>
//   path is outside the approved roots: <path>
//   not a regular file: <path>
//
// After: each names a concrete tool the caller can use instead. The model cannot widen the
// approved roots or invent a missing file — but it can List or Glob, and now it is told so.
//
// The judge for a message is: can the reader change its next call based on this?
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

function toolsFor(dir) {
  return Object.fromEntries(
    defineTools({ workspaceRoot: dir, allowedRoots: [dir], execRoots: [dir] }).map((t) => [t.name, t]),
  );
}

/** Run a handler expected to fail; return its message. */
async function failureMessage(run) {
  try {
    await run();
  } catch (error) {
    return String(error.message);
  }
  throw new Error('the call was expected to fail but succeeded');
}

test('a missing file names a way to find it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-nf-'));
  try {
    const message = await failureMessage(() => toolsFor(dir).Read.handler({ path: 'nope.txt' }));
    assert.match(message, /does not exist/);
    assert.match(message, /List|Glob/, 'the message names no tool for finding the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an out-of-root path says to stay inside the workspace', async () => {
  // The model cannot change the roots; telling it to try harder would be useless.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-root-'));
  try {
    const message = await failureMessage(() => toolsFor(dir).Read.handler({ path: '../../etc/passwd' }));
    assert.match(message, /outside the approved roots/);
    assert.match(message, /inside the workspace|List the workspace/, 'no usable next step');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reading a directory points at List', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-dir-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    const message = await failureMessage(() => toolsFor(dir).Read.handler({ path: 'sub' }));
    assert.match(message, /not a regular file/);
    assert.match(message, /directory/);
    assert.match(message, /List/, 'the message does not suggest List');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no tool error leaks an internal parameter name', () => {
  // Round 214: "oldText was not found" named a variable the caller never passed.
  const files = ['file-tools.cjs', 'tools.cjs', 'local-exec.cjs', 'workspace-tree.cjs'];
  const internal = ['oldText', 'newText', 'filePath', 'allowedRoots', 'maxEntries'];
  for (const name of files) {
    const source = fs.readFileSync(path.join(ROOT, 'desktop', name), 'utf8');
    // Only message strings matter: a template literal or quoted string passed to fail()/throw.
    for (const match of source.matchAll(/(?:fail\('[^']+',\s*|throw new Error\()['`"]([^'`"]+)/g)) {
      const message = match[1];
      for (const word of internal) {
        assert.equal(message.includes(word), false,
          name + ' leaks the internal name ' + word + ' in: ' + message);
      }
    }
  }
});
