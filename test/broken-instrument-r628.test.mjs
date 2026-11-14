// R628: one of the 65 JSON instruments was BROKEN and nothing noticed — `text-assertion-audit.cjs` threw EISDIR on every run.
//
// HOW IT WAS FOUND
//   R626 concluded the instruments are better than the ad-hoc probes substituted for them. R628 tested that by running every tool
//   advertising `--json`:
//
//       65 advertise JSON      59 exit 0 with JSON      6 "failed"
//
//   Four were my own pipe truncation, one needs a live Electron (ECONNREFUSED on 9340 is correct), and one was real:
//
//       tools/text-assertion-audit.cjs:181   EISDIR: illegal operation on a directory, read
//
// THE DEFECT
//   `resolveSubject()` builds a path from the quoted segments of `path.join(ROOT, ...)`. For a test that resolves
//   `path.join(ROOT, 'desktop')` the result is a DIRECTORY. The guard was:
//
//       if (subjectPath && fs.existsSync(subjectPath)) { ... readFileSync(subjectPath, 'utf8') ... }
//
//   `existsSync` answers "does this exist", not "is this a file", so a directory passed and readFileSync threw — and the throw
//   escaped the loop, killing the whole scan before it printed anything.
//
// THE FIX
//   `fs.statSync(p).isFile()` in a try/catch, so an unreadable subject leaves `subjectChecked: false` and the row keeps its
//   pattern-only verdict — which the tool already models. A subject that cannot be read is a row the tool cannot measure, not a
//   reason to abort 331 other assertions.
//
// WHY IT SURVIVED
//   Its test asserts on the tool's SOURCE and never runs it. That is R621's `provenance` failure one layer up: a value computed and
//   never checked becomes a tool executed and never checked.
//
// WHAT IS NOT CLAIMED
//   Not that the other 58 are silently correct: this round established only that they exit 0 with parseable JSON.
//   Not that the tool's verdicts changed: filesScanned 817 / sourceAssertions 331 / controlFlow 19 / wiring 312 — the population it
//   always would have produced, now that it can run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SWEEP, DEFECT, SURVIVED_BECAUSE } from '../desktop/broken-instrument.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the previously broken tool now exits 0 with parseable JSON', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'text-assertion-audit.cjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the tool still fails:\n' + (r.stderr || '').slice(0, 400));
  const d = JSON.parse(r.stdout);
  // The population grows every round; what must hold is that the tool completes and reports a plausible scan.
  assert.ok(d.filesScanned >= DEFECT.after.filesScanned, `filesScanned SHRANK from ${DEFECT.after.filesScanned} to ${d.filesScanned}`);
  assert.ok(d.sourceAssertions >= DEFECT.after.sourceAssertions,
    `sourceAssertions SHRANK from ${DEFECT.after.sourceAssertions} to ${d.sourceAssertions}`);
  assert.ok(Array.isArray(d.rows), 'the tool emits no rows');
});

test('the guard now tests for a file rather than mere existence', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'text-assertion-audit.cjs'), 'utf8');
  assert.ok(src.includes('isFile()'), 'the isFile guard is gone');
  assert.ok(!/if \(subjectPath && fs\.existsSync\(subjectPath\)\) \{/.test(src),
    'the existence-only guard is back');
  assert.match(src, /R628/, 'the repair is not annotated');
});

test('an unreadable subject is recorded, not fatal', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'text-assertion-audit.cjs'), 'utf8');
  assert.match(src, /subjectChecked = false|let subjectIsFile = false/, 'the fallback flag is gone');
  assert.match(src, /subjectIsFile\)/, 'the guard variable is unused');
});

test('the sweep arithmetic and the six explanations are consistent', () => {
  assert.equal(SWEEP.working + SWEEP.failed, SWEEP.advertisingJson);
  assert.equal(SWEEP.explanations.length, SWEEP.failed);
  assert.equal(SWEEP.realDefects, 1);
  const real = SWEEP.explanations.filter((e) => /REAL/.test(e.cause));
  assert.equal(real.length, 1, 'more or fewer than one real defect is recorded');
  assert.equal(real[0].tool, 'text-assertion-audit.cjs');
});

test('each non-defect explanation names a real reason', () => {
  for (const e of SWEEP.explanations.filter((x) => !/REAL/.test(x.cause))) {
    assert.ok(e.cause.length > 20, `${e.tool} has no real explanation`);
    assert.ok(/truncation|Electron|valid JSON/.test(e.cause), `${e.tool}: ${e.cause}`);
  }
});

test('the survival reason links it to the earlier never-checked class', () => {
  assert.match(SURVIVED_BECAUSE.testShape, /never executes it/, 'the test shape is not stated');
  assert.match(SURVIVED_BECAUSE.sameClassAs, /provenance/, 'the earlier instance is not cited');
  assert.match(SURVIVED_BECAUSE.sameClassAs, /one layer up/, 'the escalation is not stated');
});
