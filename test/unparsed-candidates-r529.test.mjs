// R529: the 31 files the balance scanner cannot parse, examined by a method that does not need balance.
//
// THE GAP THIS CLOSES
//   R528 answered "how many R527-shaped blocks are there" with zero — over the 1490 files its brace counter could
//   parse. Thirty-one files were reported `unparsed` because nested template literals desynchronise the counter. Those
//   are exactly where a defect could hide, and "I cannot parse it, so I say nothing" is the weakest possible answer.
//
// THE METHOD, WHICH IS THE POINT
//   No parsing. For every `{` in the named files, print the 60 characters before it and the local brace match from
//   that brace. Then rank by whether the brace reads as a BODY (`if (…)`, `else`, `try`, `catch`, `for (…)`,
//   `while (…)`) and whether the region to its matching close holds any code once comments are stripped.
//
//   A local match is exact for one brace's extent even when the file as a whole is unbalanced, provided the imbalance
//   lies outside it. So the one thing the counter could not do, this does per-brace.
//
// WHAT IT FOUND
//   818 body-shaped braces across the 31 files. Fifty have no code inside. Of those:
//       49 are `catch {}` — 20 with an explicit comment, 29 bare. Every bare one sampled is `try { … } catch {}` where
//          the try has the work and the catch deliberately swallows. That is the standard idiom, not residue.
//        1 is not a catch: `desktop/session-kernel.cjs:2474-2476`,
//              if (wasVisible && !visible) {
//                // The lifecycle owns transition timestamps and the configured timeout.
//              }
//          This is the R527 SHAPE — a body-shaped brace holding only a comment — so it had to be judged rather than
//          counted. It is correct: line 2481 calls `idleLifecycle.onVisibilityChange(sessionId, visible)`, and
//          `desktop/warm-idle-lifecycle.cjs:111-114` handles exactly this transition, setting `lastHiddenTime` and
//          starting the idle timeout. The comment states a fact about where the work lives.
//
//   Both of the branch's arms are comments. The sibling arm at 2477 also carries `scheduleVisibleWarm(sessionId)`,
//   so the asymmetry was worth checking: the hidden arm needs nothing because the scheduled warm re-checks
//   `!isVisible(sessionId)` when it fires (line 2445) and skips itself.
//
// WHAT THIS DOES NOT ESTABLISH
//   Not that the empty catches are all correct — 29 bare ones were sampled, not read one by one. Not that "no code
//   inside" is the only shape a removal can take: a body could be replaced with a plausible-looking statement.
//   Not that the local brace match is always right: a `{` inside a string or template would mislead it, and 818
//   candidates include whatever those produce.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'unparsed-candidates.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
});

let cached = null;
function report() {
  if (cached) return cached;
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  cached = JSON.parse(r.stdout);
  return cached;
}

test('it examines the same files the balance scanner could not parse', () => {
  const d = report();
  assert.ok(d.files > 20, `only ${d.files} files examined: the unparsed list may have shrunk unexpectedly`);
  assert.ok(d.candidates > 100, `only ${d.candidates} body-shaped braces found across ${d.files} files`);
});

test('every body-shaped brace closes', () => {
  const d = report();
  // A brace that never closes would make the "empty inside" judgement meaningless for that row.
  assert.equal(d.unmatched, 0,
    `${d.unmatched} body-shaped braces never close: their extent is unknown, not empty`);
});

test('no candidate is both empty and unexplained without a known idiom', () => {
  const d = report();
  const empty = d.rows.filter((r) => r.emptyBody);
  assert.ok(empty.length > 0, 'no empty bodies found at all: the detector may have stopped matching');

  // The only acceptable non-catch case is the one examined and judged correct. Any new one must be looked at, so it
  // fails here rather than passing silently.
  const nonCatch = empty.filter((r) => r.keyword !== 'catch');
  const allowed = nonCatch.filter((r) => r.file === 'desktop/session-kernel.cjs' && r.line === 2474);
  assert.equal(nonCatch.length, allowed.length,
    'a non-catch body-shaped brace holds only comments and was not examined: '
    + JSON.stringify(nonCatch.filter((r) => !allowed.includes(r)).map((r) => `${r.file}:${r.line}`)));
});

test('the one non-catch finding is recorded with why it is correct', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /session-kernel\.cjs:2474-2476/,
    'the single judged candidate is no longer named');
  assert.match(source, /warm-idle-lifecycle\.cjs:111-114/,
    'the cross-reference that settles it is gone');
  // And the underlying fact must still hold: the lifecycle really does handle the transition.
  const lifecycle = fs.readFileSync(path.join(ROOT, 'desktop', 'warm-idle-lifecycle.cjs'), 'utf8');
  assert.match(lifecycle, /!visible && previous/, 'the hidden-transition arm in the lifecycle is gone');
  assert.match(lifecycle, /lastHiddenTime = now\(\)/, 'the lifecycle no longer records the hidden timestamp');
});

test('the tool reports an unmatched brace rather than guessing', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /reported, not guessed/,
    'the unmatched-brace handling is no longer described');
  assert.match(source, /return -1;/, 'the local matcher no longer returns -1 on failure');
});

test('the limits of the method are stated', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /This tool does not try to parse/,
    'the tool no longer says it does not parse');
  assert.match(source, /a `\{` inside a string or template would mislead it|Not that the local brace match is always right/,
    'the blind spot in the local matcher is no longer disclosed');
  assert.match(source, /sampled, not read one by one/,
    'the sampling limitation on the bare catches is gone');
});
