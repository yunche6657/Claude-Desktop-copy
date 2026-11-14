// A file too large to read must be refused quickly and must say what to do instead.
//
// Measured this round: a 12 MB file is rejected in under 1 ms with
//   "file is 12582920 bytes; the read limit is 2097152"
// — correct, and completely unhelpful: the caller cannot shrink the file, and the message
// names no other tool. Round 215 established the standard (a message must let the reader
// change its next call); this was the remaining message that failed it.
//
// After: "...; this file cannot be read whole — use Glob to find a smaller file, or List to
// see what is in its directory".
//
// The size check also matters for robustness: without it the tool would try to load the whole
// file into memory. The evidence directory holds a 240 MB JSON, so this path is reachable.
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

/** Create a file of `megabytes` MB without holding it in memory. */
function writeLargeFile(target, megabytes) {
  const fd = fs.openSync(target, 'w');
  const chunk = Buffer.alloc(1024 * 1024, 'x');
  for (let i = 0; i < megabytes; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
}

test('an oversized file is refused rather than loaded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'too-large-'));
  try {
    writeLargeFile(path.join(dir, 'big.json'), 12);
    await assert.rejects(
      () => toolsFor(dir).Read.handler({ path: 'big.json' }),
      (error) => {
        assert.equal(error.code, 'too-large');
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the refusal states the size and the limit', async () => {
  // Numbers, not just words: the caller can judge how far over it is.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'too-large-msg-'));
  try {
    writeLargeFile(path.join(dir, 'big.json'), 12);
    let message = '';
    try {
      await toolsFor(dir).Read.handler({ path: 'big.json' });
    } catch (error) {
      message = String(error.message);
    }
    assert.match(message, /\d+ bytes/, 'the message omits the actual size');
    assert.match(message, /read limit is \d+/, 'the message omits the limit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the refusal names a tool the caller can use instead', async () => {
  // Round 215's standard: can the reader change its next call based on this message?
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'too-large-alt-'));
  try {
    writeLargeFile(path.join(dir, 'big.json'), 12);
    let message = '';
    try {
      await toolsFor(dir).Read.handler({ path: 'big.json' });
    } catch (error) {
      message = String(error.message);
    }
    assert.match(message, /Glob|List/, 'no alternative tool is suggested');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file just under the limit still reads', async () => {
  // The boundary must not reject legitimate files: a 1 MB file is fine, 12 MB is not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'under-limit-'));
  try {
    writeLargeFile(path.join(dir, 'ok.json'), 1);
    const result = await toolsFor(dir).Read.handler({ path: 'ok.json' });
    assert.ok(String(result.content || '').length > 0, 'a 1 MB file was refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
