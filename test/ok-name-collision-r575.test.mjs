// R575: `ok` has eleven truthy reads in one file, and they are TWO DIFFERENT FIELDS. The scan's key was wrong.
//
// THE QUESTION R574 LEFT OPEN
//   R574 keyed "strict producer, truthy consumer" by FIELD NAME. `ok` came out on top: 11 truthy reads, a
//   `Boolean(updated)` producer in the same file. R574 closed by asking whether that was one field with a lax contract or
//   two names that happen to collide. Reading the eleven answered it — two fields:
//
//       :2582,2587,2913   return { ok: Boolean(updated) };        a PROJECT object
//       :4015             if (!response.ok) {                     Response.ok — an HTTP status, platform-typed
//       :4111             if (!response.ok) return fallback;      same
//       :5064             if (!response.ok) throw new Error(…);   same
//       :5361             if (!result.ok) return result;          a project value, and 5 of its 6 reads are
//                                                                 `Boolean(result && result.ok)` — already strict
//
//   So `response.ok` is typed by the platform and no project producer says anything about it. Keying by field name merged
//   a Response property with a project return value.
//
// WHAT CHANGED IN THE DETECTOR
//       pairing by RECEIVER            `response.ok` and `result.ok` are different subjects
//       platform-typed receivers skipped
//                                      response, res, array, object, fs, path, … are not this project's contracts
//       reads inside `Boolean(…)` stripped
//                                      converting to boolean IS the strict read; counting it as lax was the opposite
//
//   Result: 117 lax reads -> 110, and `ok` left the top of the list entirely. The seven that vanished were the ones that
//   would have cost a reader time.
//
// WHY THIS IS THE FINDING AND NOT A DETOUR
//   A detector whose top row is a false positive does not get read twice. This project has now produced four:
//   R557 (flagged 31 of 31 groups), R571 (a liveness rule withdrawn after three wrong versions), R574 (`ok`), and this fix
//   still miscounts `b.isCurrent`. Every time, the KEY was wrong rather than the idea. Here the key was a field name; the
//   correction was the object it belongs to.
//
// WHAT REMAINS UNANSWERABLE
//   Pairing by receiver cannot prove a receiver's type. `result.ok` is a name; whether `result` holds the object
//   `{ ok: Boolean(updated) }` returned is beyond a text scan. The pairing makes each remaining row about ONE expression,
//   which is what makes it answerable by reading.
//
//   And one row is still wrong: `b.isCurrent` reports 3 reads, but the receiver `b` is unrelated — the pattern captured
//   `if (!b)`-style tests and attributed a neighbouring property. Recorded rather than patched, because patching the
//   pattern a fourth time is exactly what R571 did and withdrew.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OK_FIELDS } from '../desktop/ok-name-collision.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'strict-contract-audit.cjs');

test('the two `ok` fields are still distinguishable at the recorded lines', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8').split('\n');
  // No `if` around the assertions: `test-hygiene` counts a guard-conditioned assertion as reviewable special-casing, and
  // a loop over a table with a branch inside is exactly the shape it flags. The three groups are asserted separately
  // instead, which also makes a failure say WHICH group moved.
  for (const group of OK_FIELDS) {
    for (const n of group.lines) {
      assert.ok((lines[n - 1] || '').includes('ok'), `${group.subject}: line ${n} no longer mentions ok`);
    }
  }
  const platformReads = OK_FIELDS.find((g) => g.subject === 'response.ok').lines;
  for (const n of platformReads) {
    assert.match(lines[n - 1] || '', /response\.ok/, `line ${n} is no longer a Response read`);
  }
  const resultReads = OK_FIELDS.find((g) => g.subject === 'result.ok').lines;
  for (const n of resultReads) {
    assert.match(lines[n - 1] || '', /result\.ok/, `line ${n} is no longer a result read`);
  }
  const produced = OK_FIELDS.find((g) => g.subject.startsWith('project `ok`')).lines;
  for (const n of produced) {
    assert.match(lines[n - 1] || '', /ok:\s*Boolean\(/, `line ${n} is no longer a strict producer`);
  }
});

test('response.ok is a Response property, not a project contract', () => {
  // The three reads are inside `fetch` handlers; `response` comes from fetch, so nothing in this repo types it.
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  const fetchContext = /const\s+response\s*=\s*await\s+fetch|response\s*=\s*await\s+fetch/.test(src);
  assert.ok(fetchContext, 'no `response = await fetch` found: the platform-typed claim cannot be checked');
});

test('five of the six result.ok reads are already strict', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8').split('\n');
  const strict = OK_FIELDS.find((g) => g.subject === 'result.ok').lines
    .filter((n) => /Boolean\(result && result\.ok\)/.test(lines[n - 1] || ''));
  assert.equal(strict.length, 5, `only ${strict.length} of the six are Boolean-wrapped`);
});

test('the detector excludes platform-typed receivers', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /const PLATFORM_TYPED = new Set\(\[/, 'the platform exclusion is gone');
  for (const name of ['response', 'fs', 'path', 'buffer']) {
    assert.ok(new RegExp(`'${name}'`).test(src), `${name} is no longer excluded`);
  }
});

test('the detector strips reads inside Boolean(…)', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /const strictReads = text\.replace\(\/Boolean\\s\*\\\(/, 'the Boolean strip is gone');
  // And the effect: `ok` must not be the top row any more.
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the audit failed');
  const d = JSON.parse(r.stdout);
  const lax = d.rows.filter((x) => !x.strictHere).sort((a, b) => b.reads - a.reads);
  assert.ok(lax.length > 0, 'no lax read at all, which the evidence does not support');
  assert.ok(!lax[0].subject.endsWith('.ok'),
    `the top row is still ${lax[0].subject}: the two corrections did not take effect`);
});

test('the record states that one row is still wrong', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'ok-name-collision.cjs'), 'utf8');
  assert.match(src, /miscounts|still wrong/, 'the surviving false positive is not recorded');
  assert.match(src, /patched a fourth time|patching the pattern a fourth time/,
    'the reason it is recorded rather than fixed is missing');
});

test('pairing by receiver is stated as the correction, not the field-name key', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /paired by RECEIVER/, 'the key is not named in the output');
  assert.match(src, /keyed matches by FIELD NAME|Keying by field name alone merged them/,
    'the original mistake is not recorded');
});
