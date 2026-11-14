// Meta-test: this suite must not contain assertions that can silently skip.
//
// The recurring failure in this project has been a test that is green because it measured
// nothing. Concrete instances:
//   round 180: `if (rows.length) { assert(...) }` — the helper never received a store path,
//              so the guard always skipped and the test never proved persistence.
//   round 142: an assertion looked at prose, not at behaviour, and stayed green under a
//              mutation that broke the feature.
//
// The rule enforced here: an `assert` may not be the first statement inside an `if`, and a
// bare `return` with no assertion in its branch is only allowed when that branch asserts
// something about the environment first.
//
// Environment-dependent skips ARE legitimate (a host without the installed app, a platform
// without TCC). Those must still assert what that environment implies, which is exactly what
// the two guards hardened this round now do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardBlock, bodyAsserts, scanText } from '../tools/guard-scan.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

/** Files whose guards have been reviewed and are legitimate environment skips. */
const REVIEWED = new Set([
  'app-version.test.mjs',
  'busy-shell-pty-keys.test.mjs',
  'claude-vm.test.mjs',
  'computer-use-tcc.test.mjs',
  'default-browser-name.test.mjs',
  'exec-allowlist-semantics.test.mjs',
  'file-download.test.mjs',
  'frontend-root.test.mjs',
  'gh-available.test.mjs',
  'git-available.test.mjs',
  'chinese-locale.test.mjs',
  // Reviewed this round: each guards on the host's environment (a missing binary, a platform
  // without the facility, a network-dependent null) and still asserts what that branch implies.
  'effort-thinking.test.mjs',
  'installed-editors.test.mjs',
  'notifications.test.mjs',
  'period-usage.test.mjs',
  'session-file-read.test.mjs',
  'set-transcript.test.mjs',
  // Reviewed R546: each skip means the INPUT has nothing to assert about, not that a tool failed to find it.
  //   index-recall-r486            firstNonTitle === -1 means every row is a title hit, so there is no boundary to
  //                                place; the >10-rows assertion already established the run was not empty.
  //   package-installer-r483       the condition is a property of the environment (a root path containing a space),
  //                                and the staging notice would be wrong to demand on a space-free root.
  //   sourcemap-exclusion-r462     a non-junction ion-dist is a different legitimate layout, so the junction fact this
  //                                test documents does not apply; the missing-directory case returns earlier.
  //   tool-inventory-r487          status 0 is one of two documented outcomes (resolve the in-repo checkout), and the
  //                                branch guards the failure message of the other.
  // The four HOLEs found in the same pass were removed rather than listed here: comment-selfmatch-explain-r521,
  // not-logged-in-r481, porting-notes-r449, sourcemap-exclusion-r462's asar fallback.
  'index-recall-r486.test.mjs',
  'package-installer-r483.test.mjs',
  'sourcemap-exclusion-r462.test.mjs',
  'tool-inventory-r487.test.mjs',
]);

function testFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'));
}

/**
 * How many guards each reviewed file actually has, measured with tools/guard-scan.cjs.
 *
 * WHY A COUNT AND NOT A BOOLEAN
 *   The reviewed list says "this file's conditional assertions were looked at". It does not say "this file has exactly
 *   one". Six files carry two or three — `default-browser-name` checks three platform cases — and demanding one
 *   reported them all as violations on the first run.
 *
 *   A count that matches reality is the checkable form: if someone adds a guard to a reviewed file, the number changes
 *   and the test says so, without pretending the file should have had only one.
 *
 * FIVE ENTRIES ARE ZERO, AND THAT IS THE RECORD OF THE NARROWED RULE
 *   `chinese-locale`, `effort-thinking`, `set-transcript`, `index-recall-r486`, `package-installer-r483`,
 *   `sourcemap-exclusion-r462` and `tool-inventory-r487` currently report no guard: R547 narrowed the rule to "the
 *   whole block is assertions", and these files' conditionals compute or loop first. They stay in REVIEWED because the
 *   review happened and the reasons still hold; a zero here means the rule does not describe them today, not that the
 *   review was wrong.
 */
const REVIEWED_GUARD_COUNTS = {
  'app-version.test.mjs': 1,
  'busy-shell-pty-keys.test.mjs': 1,
  'claude-vm.test.mjs': 2,
  'computer-use-tcc.test.mjs': 2,
  'default-browser-name.test.mjs': 3,
  'exec-allowlist-semantics.test.mjs': 2,
  'file-download.test.mjs': 1,
  'frontend-root.test.mjs': 1,
  'gh-available.test.mjs': 1,
  'git-available.test.mjs': 2,
  'chinese-locale.test.mjs': 0,
  'effort-thinking.test.mjs': 0,
  'installed-editors.test.mjs': 3,
  'notifications.test.mjs': 1,
  'period-usage.test.mjs': 1,
  'session-file-read.test.mjs': 1,
  'set-transcript.test.mjs': 0,
  'index-recall-r486.test.mjs': 0,
  'package-installer-r483.test.mjs': 0,
  'sourcemap-exclusion-r462.test.mjs': 0,
  'tool-inventory-r487.test.mjs': 0,
};

test('no unreviewed test wraps its assertion in a guard', () => {
  // The exact shape that let round 180 pass without proving anything.
  //
  // `assert.fail` IS NOT A GUARDED ASSERTION, AND COUNTING IT MADE THE SCANNER WRONG ABOUT ITS INPUT
  //   `installer-carries-patch-r479.test.mjs:101` reads `if (!fs.existsSync(deployed)) { assert.fail(…) }`. That is
  //   an assertion with a clearer message, not a condition around one: the body throws unconditionally, so the test
  //   can never pass through that path. The pattern matched the `if (` + `assert.` shape and reported it as an
  //   unreviewed guard — a finding about the scanner, not about the test.
  //
  //   Excluding `assert.fail` is not a loosening: a guard whose body starts with `assert.fail` still fails whenever its
  //   condition holds, which is the opposite of the failure mode this test exists to catch.
  //
  // AND THE SCAN NOW READS THE WHOLE BLOCK, NOT ONE LINE
  //   Looking only at `lines[i + 1]` found a guard indented one line deeper exactly as well as it found nothing:
  //
  //       if (cond) {
  //         const x = compute();      <- the assertion is here, one line down
  //         assert.equal(x, 1);
  //       }
  //
  //   That is the same failure the test exists to catch, and the old pattern missed it. `guardBlock` walks the braces
  //   to find the block's extent and `bodyAsserts` asks whether anything inside asserts. Unparseable guards are
  //   collected separately in `unparsed` and reported, because "could not read it" must not read as "clean".
  const offenders = [];
  const unparsed = [];
  for (const file of testFiles()) {
    const text = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    // `scanText` owns the loop, the opener test and the block extent. This call site used to reimplement all three,
    // and its private copy of the "is this blockless?" test was the last place still fooled by `async json() { … }`
    // inside a returned object literal — the fix had landed in tools/guard-scan.cjs but not here.
    const { found, unparsed: bad } = scanText(text);
    for (const line of bad) unparsed.push(file + ':' + line + '  ' + text.split('\n')[line - 1].trim());
    if (REVIEWED.has(file)) continue;
    for (const hit of found) offenders.push(file + ':' + hit.line + '  ' + hit.text);
  }
  assert.deepEqual(unparsed, [],
    'these guards could not be read, so whether they hide an assertion is unknown:\n' + unparsed.join('\n'));
  assert.deepEqual(offenders, [], 'a new guard-condition assertion was added:\n' + offenders.join('\n'));
});

test('the reviewed skips each assert something about the environment', () => {
  // A reviewed file must not get a SECOND, unreviewed guard later. The reviewed list exempts a file; it does not
  // exempt every guard in it.
  //
  // THE OLD CHECK COULD NOT FAIL
  //   It found `if (` followed by a line starting with `assert.`, then asserted that a four-line window contains
  //   `assert.` — which the guard condition had already guaranteed. A tautology dressed as a check, and it also read
  //   only one line, so it could not have noticed a second guard two lines down.
  //
  // REPLACED WITH A COUNT THAT MUST MATCH THE RECORD
  //   The first replacement demanded at most one guard per reviewed file and immediately failed on six files carrying
  //   two or three each — `default-browser-name` has three, because a host can be checked for a default browser on
  //   several platforms. Multiple guards in a reviewed file are legitimate; what is not legitimate is a curated count
  //   that has drifted from reality. So the file declares how many guards it reviewed, and the scan must agree.
  const offenders = [];
  for (const file of REVIEWED) {
    const full = path.join(TEST_DIR, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    const { found } = scanText(text);
    const declared = REVIEWED_GUARD_COUNTS[file];
    if (declared === undefined) {
      offenders.push(`${file}: has ${found.length} guard(s) at lines ${found.map((f) => f.line).join(', ')}`
        + ' but no reviewed count was recorded');
      continue;
    }
    if (found.length !== declared) {
      offenders.push(`${file}: ${found.length} guard(s) at lines ${found.map((f) => f.line).join(', ')}`
        + ` but ${declared} was reviewed`);
    }
  }
  assert.deepEqual(offenders, [],
    'the reviewed guard counts no longer match the files:\n' + offenders.join('\n'));
});

test('every test file declares at least one assertion', () => {
  // A file of nothing but setup is not a test.
  for (const file of testFiles()) {
    const text = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    assert.match(text, /assert\.|assert\(/, file + ' contains no assertion at all');
  }
});
