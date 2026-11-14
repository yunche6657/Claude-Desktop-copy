// R597: the "unstable" tier held six rows with three different reasons. Splitting the call pairs leaves one real asymmetry.
//
// THE PROBLEM WITH ONE TIER
//   R594 classified a key as `call` and put it in the unstable tier, because a call MIGHT return a fresh object. R596 widened the
//   population to 202 maps and the tier grew to six rows — and those six turned out to need three different reads:
//
//       hostPending        set key(id)                  get key(q.id)          same function, different argument
//       once               set key(state.id,state.origin) get key(id,origin)    same function, different argument
//       pending            set key(id,origin)            get key(id,origin)     identical — already agreeing by text? no,
//                                                                                the tier fired because shape is `call`
//       sessionDirWatchers set watcherKey(a,b)           get key                a stable template, read via a variable
//       out (×2)           set Number(m[1])              get n                  a primitive, read via a variable
//       tabAdmissions      set serverId+'\0'+(…'seed')   get serverId+'\0'+where.tabId   the REAL asymmetry (R596)
//
// WHAT THE NEW LAYER DOES
//   When both sides are calls, compare the CALLEE and the ARGUMENT LIST:
//
//       same-call                    identical text — nothing to read
//       same-callee-different-args   one function, two arguments — the argument difference is the subject, not the callee
//       different-callee             two key functions — cannot agree, and now the only suspicious call shape
//
//   Measured on the six: two `same-callee-different-args`, one `same-call`, three not-calls (one real asymmetry, two stable
//   primitives already read). So the tier's population drops to the rows a reader actually has to think about.
//
// WHY `same-callee-different-args` IS NOT REPORTED AS A PROBLEM
//   `key(id)` and `key(q.id)` both produce the same string when `id` is the value of `q.id`. Whether it is depends on the
//   caller, not on the key function — which is precisely the kind of question a text scan cannot answer and a one-line read
//   can. Marking it as a distinct class is the honest output; marking it as suspicious would recreate the false-positive
//   problem this project has now hit four times.
//
// WHAT IS NOT CLAIMED
//   Not that `tabAdmissions` is the only real one forever: it is the only one in this population, and the population is 202
//   maps that a scan can see. A key built from a helper in another module is invisible, as always.
//   Not that `different-callee` is always wrong: `set normalize(x)` / `get normalize(y)` would be two names for one function,
//   which only the import graph could confirm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callRelation, callSite, keyShape } from '../tools/map-key-reach.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'map-key-reach.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the three call relations are distinguished', () => {
  assert.equal(callRelation('key(id)', 'key(id)'), 'same-call');
  assert.equal(callRelation('key(id)', 'key(q.id)'), 'same-callee-different-args');
  assert.equal(callRelation('keyOf(a)', 'otherKey(a)'), 'different-callee');
  assert.equal(callRelation('key(a)', 'a.b'), null, 'a non-call should yield null');
  assert.equal(callRelation('{ a }', 'key(a)'), null);
});

test('callSite splits a callee from its argument list', () => {
  assert.deepEqual(callSite('key(a, b)'), { fn: 'key', args: 'a, b' });
  assert.deepEqual(callSite('node.normalise(x)'), { fn: 'node.normalise', args: 'x' });
  assert.equal(callSite('plainIdentifier'), null);
});

test('a call/call pair always records a relation, and a call/non-call pair correctly does not', () => {
  const d = runScan();
  // A call-shaped SET whose READ is not a call has no relation to record. That null is correct: there is no second callee
  // to compare. Only pairs with calls on BOTH sides can be classified, and those must all carry one.
  const callSets = d.rows.filter((r) => keyShape(r.setKey) === 'call' && r.readKey);
  const bothCalls = callSets.filter((r) => keyShape(r.readKey) === "call");
  assert.ok(bothCalls.length >= 3, `only ${bothCalls.length} rows have calls on both sides`);
  for (const r of bothCalls) {
    assert.ok(r.callRelation, `${r.name} is call/call but has no recorded relation`);
  }
  const mixed = callSets.filter((r) => keyShape(r.readKey) !== "call");
  for (const r of mixed) {
    assert.equal(r.callRelation, null, `${r.name} is call/non-call but recorded a relation`);
  }
});
test('the two same-callee rows are classified as such, not as suspicious', () => {
  const d = runScan();
  for (const name of ['hostPending', 'once']) {
    const row = d.rows.find((r) => r.name === name);
    assert.ok(row, `${name} is no longer found`);
    assert.equal(row.callRelation, 'same-callee-different-args',
      `${name} is not classified as one function with two arguments`);
  }
});

test('the real asymmetry is still the one non-call unstable row', () => {
  const d = runScan();
  const tab = d.rows.find((r) => r.name === 'tabAdmissions');
  assert.ok(tab, 'tabAdmissions is not found');
  assert.equal(tab.callRelation, null, 'tabAdmissions is now call-shaped, so the R596 finding needs re-reading');
  assert.equal(tab.unstableSet, true, 'tabAdmissions is no longer flagged');
  assert.equal(tab.agrees, false);
});

test('every unstable row now falls into one of the explained classes', () => {
  const d = runScan();
  const unstable = d.rows.filter((r) => r.unstableSet);
  assert.ok(unstable.length >= 4, `only ${unstable.length} unstable rows`);
  for (const r of unstable) {
    const explained = r.callRelation !== null || r.name === 'tabAdmissions' || r.setKey.startsWith('Number(')
      || /watcherKey/.test(r.setKey);
    assert.ok(explained, `${r.name} (${r.setKey}) is unstable and unexplained`);
  }
});
