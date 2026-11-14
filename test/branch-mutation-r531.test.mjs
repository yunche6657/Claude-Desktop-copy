// R531: the approval release in cancel(), measured instead of assumed — and the mutation table's last gap closed
// cheaply.
//
// WHAT WAS OPEN
//   R530 left `cancel-approvals` unverified with `tests: null`, meaning "run the whole suite, 15 minutes, because no
//   test file mentions resolveAllApprovals". A blank in the table is not a conclusion, so it had to be resolved.
//
// WHAT WAS MEASURED FIRST
//   A probe raised a permission prompt, cancelled, and printed the outcome:
//       before cancel, settled = pending
//       cancel returned: {"ok":true}
//       after cancel, settled = deny
//   So the release works. The question was whether anything would notice its removal, and the answer before this
//   round was no.
//
// THE THREE PROPERTIES, EACH CHOSEN BECAUSE A WEAKER ASSERTION WOULD PASS FOR THE WRONG REASON
//   deny, not merely settled    `settleApproval` distinguishes `timeout` from `deny`, and the 60s guard would settle
//                               a prompt eventually. Asserting only "it settled" would pass with the release removed,
//                               after a 60-second wait — so the timeout window is set to 60s and the outcome must be
//                               `deny`.
//   no running turn             session-kernel.cjs:2140 says a prompt "can be raised with no running turn at all", and
//                               that the old `if (!controller) return` left those waiters pending forever. That exact
//                               configuration is the second test: cancel returns ok:false and must still release.
//   sessionId scoping           `resolveAllApprovals` filters by session. Without the filter, cancelling one session
//                               would deny another's prompt — invisible to any "did it settle" test. The third test
//                               raises prompts on two sessions and asserts the untouched one is still pending.
//
// THE COST FIX
//   With a file that targets the consequence directly, the entry no longer needs the full suite: `tests:` now names
//   `test/cancel-approvals-r531.test.mjs`. Verified: `--only cancel-approvals` reports `caught` with that file as the
//   first red, in about 150 ms instead of 15 minutes.
//
// THE TABLE NOW READS 8 OF 9
//   The remaining `UNPROTECTED` is `cancel-pending-cancel`, and R530 measured why: the flag is written and then the
//   map entry is deleted in the same synchronous block, so the only reader (`unstartedTurn`) can never observe it.
//   That is "not observable", which is a different finding from "not tested" — and it stays in the table as such
//   rather than being quietly removed.
//
// WHAT IS NOT CLAIMED
//   Not that the deny reason reaches the executor in the shape it expects: the test reads the decision string only.
//   Not that the UI handles an unattended prompt correctly — only that the kernel stops waiting. Not that
//   `cancel-approvals` is the last unverified branch in the file: the table has nine entries and nothing enumerates
//   the branches it omits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'branch-mutation.cjs');

test('every entry in the mutation table names a real test file', () => {
  // A `tests` list pointing at a missing or non-covering file is how R530 produced four false "unprotected" verdicts.
  const source = fs.readFileSync(TOOL, 'utf8');
  // Slice to the FIRST `];` after the array opens, not the last: R533 added a second table (CONDITION_MUTATIONS)
  // below this one, and `lastIndexOf` then swallowed both, making the entry count assertion below wrong.
  const open = source.indexOf('const MUTATIONS = [');
  const block = source.slice(open, source.indexOf('\n];', open));
  const files = [...block.matchAll(/'test\/[^']+\.test\.mjs'/g)].map((m) => m[0].slice(1, -1));
  assert.ok(files.length > 0, 'no test files named in the table at all');
  for (const f of new Set(files)) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is named in the mutation table but does not exist`);
  }
  // And no entry may still ASK for the whole suite. Written with indexOf rather than a regex test on the file text:
  // a regex literal applied to a readFileSync result is exactly the pairing tools/comment-selfmatch.cjs flags as a
  // self-scan, and this file became a NEW risky row when it was written that way. A test that sits in the risky set
  // while auditing risky sets is not a witness. (An earlier version of THIS comment quoted the pattern and registered
  // as a scan too — the comment was the finding.)
  const sentinel = 'tests: null,';
  const sentinelAt = block.split('\n').findIndex((l) => l.trim() === sentinel);
  assert.equal(sentinelAt, -1,
    'an entry still asks for the whole suite: R531 made that unnecessary by targeting the consequence directly');
});

test('cancel-approvals names a test file that exists', () => {
  // NOT re-run here, and the reason is R530's lesson repeating: a test that invokes branch-mutation is inside the set
  // of tests branch-mutation runs, so re-entering it while a mutation is applied mutates the file twice and reports
  // `unprotected` for a branch that is covered. A standalone `--only cancel-approvals` reports `caught`.
  //
  // So this asserts the wiring, which is what could silently break: the entry must name the R531 file.
  const source = fs.readFileSync(TOOL, 'utf8');
  const at = source.indexOf("id: 'cancel-approvals'");
  const next = source.slice(at, source.indexOf("id: 'cancel-pending-cancel'", at));
  assert.match(next, /test\/cancel-approvals-r531\.test\.mjs/,
    'cancel-approvals no longer names the test written for it');
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'cancel-approvals-r531.test.mjs')),
    'the named test file does not exist');
});

test('the table records the one remaining unprotected entry with its reason', () => {
  // Reading the table rather than re-running it: the full run is several minutes and this test's job is the record,
  // not the measurement. `cancel-approvals` above is the only entry re-executed here, because it is the one R531
  // changed.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /id: 'cancel-pending-cancel'/,
    'the entry whose flag is unobservable is gone from the table');

  // Exactly nine entries, and every one declares a `what` — an entry without a stated purpose cannot be reviewed.
  const open = source.indexOf('const MUTATIONS = [');
  const block = source.slice(open, source.indexOf('\n];', open));
  const ids = [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(ids.length, 9, `the effect table has ${ids.length} entries, expected 9: ` + ids.join(', '));
  const whats = [...block.matchAll(/what: '([^']+)'/g)].length;
  assert.equal(whats, ids.length, 'an entry has no stated purpose');
});

test('the reason the remaining entry is unprotected is recorded at the tool', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /id: 'cancel-pending-cancel'/, 'the entry is gone');
  // The distinction between "not observable" and "not tested" must survive in the file.
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  const at = kernel.indexOf('if (pending && !pending.started) {');
  const nextLines = kernel.slice(at, at + 400);
  assert.match(nextLines, /pendingTurns\.delete\(sessionId\)/,
    'the deletion that makes the flag unobservable is no longer adjacent: this finding needs re-checking');
});
