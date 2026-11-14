// Hostile text must survive a save/load cycle, not just a single turn.
//
// Round 194 proved the characters reach the agent verbatim. This round checks the other half:
// they must also be written to the store and read back unchanged.
//
// Measured through a real store file:
//   store bytes 11706, valid JSON: true
//   nullByte      rows=2  verbatim=true
//   control       rows=2  verbatim=true
//   loneSurrogate rows=2  verbatim=true
//   rtl           rows=2  verbatim=true
//
// The failure this guards against is silent: a naive JSON writer that embeds a raw null byte
// produces a file that looks fine until the next launch tries to parse it and the whole
// session list comes back empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

const CASES = {
  'null byte': 'before\u0000after',
  'control character': 'a\u0001b',
  'lone surrogate': 'x\uD800y',
  'right-to-left override': 'p\u202Eq',
};

/** Write every case through one kernel, reload with a second, return both views. */
function persistAndReload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostile-store-'));
  const storePath = path.join(dir, 'store.json');
  const make = () => createSessionKernel({
    emit: () => {},
    log: () => {},
    storePath,
    createAgent: () => ({ model: 'stub', tools: [], async run() { return { text: 'ok' }; } }),
  });
  return { dir, storePath, make };
}

test('hostile text survives a save and reload verbatim', async () => {
  const { dir, storePath, make } = persistAndReload();
  try {
    const ids = {};
    const first = make();
    for (const [name, text] of Object.entries(CASES)) {
      const session = first.start({ cwd: ROOT });
      ids[name] = session.sessionId;
      await first.sendMessage(session.sessionId, text);
    }
    first.flush();

    assert.ok(fs.existsSync(storePath), 'nothing was written to the store');
    const raw = fs.readFileSync(storePath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'the store is not valid JSON after hostile input');

    const second = make();
    for (const [name, text] of Object.entries(CASES)) {
      const rows = second.getTranscript(ids[name]);
      assert.ok(Array.isArray(rows) && rows.length > 0, name + ': the transcript did not reload');
      // Locate the user row rather than searching the whole transcript: the text landing in
      // the assistant row would still satisfy a blob search while breaking the conversation.
      const userRow = rows.find((row) => row.type === 'user');
      assert.ok(userRow, name + ': the reloaded transcript has no user row');
      const escaped = JSON.stringify(text).slice(1, -1);
      assert.ok(JSON.stringify(userRow.message.content).includes(escaped),
        name + ': the text changed during the save/load cycle');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the store on disk contains no raw control bytes', async () => {
  // A raw 0x00 inside a JSON string is invalid; the writer must escape it as \u0000.
  const { dir, storePath, make } = persistAndReload();
  try {
    const kernel = make();
    const session = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(session.sessionId, 'before\u0000after');
    kernel.flush();
    const raw = fs.readFileSync(storePath, 'utf8');
    assert.equal(raw.includes('\u0000'), false, 'a raw NUL byte was written into the store');
    assert.ok(raw.includes('\\u0000'), 'the NUL was not escaped as \\u0000 either');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reloaded transcript still renders as a string array', async () => {
  // The renderer walks message.content; a non-string entry would break the conversation view.
  const { dir, make } = persistAndReload();
  try {
    const kernel = make();
    const session = kernel.start({ cwd: ROOT });
    await kernel.sendMessage(session.sessionId, 'x\uD800y');
    kernel.flush();
    const rows = make().getTranscript(session.sessionId);
    for (const row of rows) {
      const content = row.message && row.message.content;
      assert.ok(typeof content === 'string' || Array.isArray(content),
        'a row content is neither a string nor an array after reload');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
