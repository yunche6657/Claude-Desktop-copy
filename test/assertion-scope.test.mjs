// Assertions must name the record they are about, not search a whole blob for a string.
//
// Round 192 lost three attempts to this: a check that searched all transcripts for
// "数字普惠金融" stayed green after the owning transcript was emptied, because the same
// string also appeared in a shorter session. The fix was to locate the owning record first
// and assert on that record.
//
// The same shape appears when a transcript's text is asserted through the whole array:
// moving the text into the wrong row keeps the string present, so a blob search passes
// while the conversation is broken. Measured this round by changing userEntry.type to
// 'assistant': the old `JSON.stringify(entries).includes('RESTART-TOKEN')` stayed green;
// the row-scoped version failed with "the reloaded transcript has no user row".
//
// Allowed exceptions are listed with a reason: searching a blob is legitimate when the test
// is explicitly about absence ('this value must appear nowhere').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

/** file -> the reason a blob search is the right assertion there. */
const ALLOWED = new Map([
  ['claude-mode.test.mjs', 'asserts a value appears NOWHERE, which is a whole-blob claim'],
  ['composer-input.test.mjs', 'the agent request is the blob; there is no finer record'],
  ['conversation-history-end-to-end.test.mjs', 'the transcript array is the unit under test'],
  ['session-store-preservation.test.mjs', 'locates the owning transcript before asserting on it'],
  ['policy-identity-proof-r378.test.mjs', 'verifies the fixture token appears nowhere in the result'],
]);

test('no test proves a fact by searching a blob it did not locate', () => {
  const offenders = [];
  for (const file of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'))) {
    const lines = fs.readFileSync(path.join(TEST_DIR, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      // Only an unscoped blob counts: `JSON.stringify(rows)` or `JSON.stringify(entries)`.
      // A located record (`rows[0].message.content`, `userRow.message.content`) is exactly
      // what this rule wants, so it must not be flagged.
      // Skip comment lines: this file quotes the banned pattern while explaining it.
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (!/JSON\.stringify\(\s*[A-Za-z_$][\w$]*\s*\)\.includes\(/.test(line)) return;
      if (ALLOWED.has(file)) return;
      offenders.push(file + ':' + (index + 1) + '  ' + line.trim().slice(0, 80));
    });
  }
  assert.deepEqual(offenders, [],
    'these assertions search a blob instead of naming a record:\n' + offenders.join('\n'));
});

test('every allowed exception still explains itself', () => {
  // An allowlist entry with no reason is how exceptions become permanent by accident.
  for (const [file, reason] of ALLOWED) {
    assert.ok(reason && reason.length > 15, file + ' is allowed without a real reason');
    assert.ok(fs.existsSync(path.join(TEST_DIR, file)), file + ' no longer exists; drop its entry');
  }
});
