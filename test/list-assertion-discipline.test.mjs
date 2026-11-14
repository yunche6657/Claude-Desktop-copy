// An assertion about a dynamic list must check the LIST, not one word that also appears
// somewhere fixed in the same string.
//
// Found while auditing the error-messages teammate's work this round. Its test for the
// allowlist refusal asserted:
//
//   assert.match(message, /node/);
//   assert.match(message, /git/);
//
// Both words also appear in the fixed tail of that same message ("node and git are the
// safest"). Deleting the entire accepted-names list therefore left the test green — measured:
// 26/26 still passed. The corrected assertion compares the count against
// ALLOWED_EXECUTABLES and reported "2 of 29" under the same mutation.
//
// The general shape: a message that embeds a collection is asserted with proxy words. This
// file flags that pattern so it is visible in review rather than only under mutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

// Tests reviewed for the proxy-word pattern and cleared, each with the reason.
const REVIEWED = new Map([
  ['tool-error-messages.test.mjs', 'the allowlist case now counts entries against ALLOWED_EXECUTABLES'],
]);

// NOTE: an earlier version of this file also tried to detect the pattern across the whole
// suite with a heuristic. It proved unreliable in both directions (false positive on a correct
// single `/List/` match, false negative after a mutation that kept an unrelated `includes(`
// in the same file), so it was removed rather than trusted. What remains is the pin below:
// the corrected assertion cannot silently regress to the weak form.

test('the allowlist assertion counts entries rather than words', () => {
  // Pin the corrected form so the weaker version cannot come back.
  const source = fs.readFileSync(path.join(TEST_DIR, 'tool-error-messages.test.mjs'), 'utf8');
  assert.match(source, /ALLOWED_EXECUTABLES/, 'the count-based assertion is gone');
  assert.match(source, /listed\.length, exec\.ALLOWED_EXECUTABLES\.size/, 'the entry count is not compared');
});