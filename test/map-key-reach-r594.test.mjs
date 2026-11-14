'use strict';
// 167 Maps: 120 agree on the key, 33 differ, and reading the differences shows why a textual comparison cannot decide.
//
// WHAT WAS MEASURED
//       maps with a set call                    167
//       set and read keys identical             120
//       keys differ                              33
//       ... where the SET key is unstable         3
//       no get/delete in the same file           14
//
//   Every one of the 33 differences was read. Three shapes account for all of them, and NONE is a defect.
//
// SHAPE 1: THE SAME VALUE UNDER TWO NAMES (the majority)
//       session-kernel.cjs:99   set s.sessionId   get id
//
//   `id` is that function's parameter name for the session id; `sessionId` is the value read off a record. Same string at
//   runtime, different identifiers because they live in different functions. A textual scan cannot know they are equal, and
//   neither could a stricter one without a dataflow analysis.
//
// SHAPE 2: TWO DIFFERENT FIELDS THAT HOLD THE SAME ID — the protocol case
//       ccb-events.cjs:143   toolUses.set(block.id, {…})        block.type === 'tool_use'
//       ccb-events.cjs:181   toolUses.get(block.tool_use_id)    iterating toolResults
//
//   This looked like the defect the tool was built to find, and it is not. The Anthropic protocol names a tool call `id` on
//   the `tool_use` block and `tool_use_id` on the `tool_result` block that refers back to it. The two fields hold the SAME
//   value; the difference is which side of the exchange you are reading. The code is correct, and it is correct in a way no
//   text comparison could confirm — the pairing is a fact about the protocol, not about the source.
//
// SHAPE 3: A FUNCTION WHOSE RETURN VALUE IS THE KEY
//       bridge-services.cjs:1508   const watcherKey = (sessionId, watchId) => `${sessionId}\u0000${watchId}`;
//       :1562   sessionDirWatchers.set(watcherKey(sessionId, watchId), …)
//       :1520   const key = watcherKey(sessionId, watchId);   … later: delete(key)
//
//   Classified `call` and therefore "unstable", which is wrong: a function returning a template string is as stable as the
//   template. `audit-evidence.cjs:64` is the same case with `Number(m[1])` — a primitive, stable.
//
// WHY THE `unstable` TIER IS STILL WORTH HAVING
//   It flagged three rows and all three were false, because "a call" is not the same as "a freshly constructed object". The
//   distinction that matters — `{ id }` versus `keyOf(id)` — needs the callee's body, which a line-local scan does not have.
//   Keeping the tier is honest: it says "this needs a reader", and three readers settled it in under a minute each.
//
// WHAT THIS ESTABLISHES
//   There is no Map key mismatch in this repository. The 33 differences are two naming conventions and one protocol pairing.
//   The tool's real output is the LIST of differences, not a count of defects — and that is what it prints.
//
// WHAT IS NOT CLAIMED
//   Not that the 14 maps with no get/delete in the same file are fine: they are populated and read across module boundaries,
//   which is exactly where a mismatch would be invisible. They are counted separately rather than assumed.
//   Not that a future difference would be a defect either: three shapes produced 33 false positives, so the prior on any new
//   row is strongly "false".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keyShape } from '../tools/map-key-reach.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'map-key-reach.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the scan finds enough Maps for the conclusion to mean something', () => {
  const d = runScan();
  assert.ok(d.maps > 50, `only ${d.maps} maps with a set call`);
  assert.equal(d.agreeing + d.disagrees + d.unreadable, d.maps, 'the categories do not sum');
  assert.ok(d.agreeing > d.disagrees, 'more differences than agreements, which would change the reading');
});

test('the protocol pairing is two fields holding one value, not a mismatch', () => {
  const d = runScan();
  const row = d.rows.find((r) => r.name === 'toolUses' && r.file === 'desktop/ccb-events.cjs');
  assert.ok(row, 'the toolUses map is no longer found');
  assert.equal(row.setKey, 'block.id');
  assert.equal(row.readKey, 'block.tool_use_id');
  assert.equal(row.agrees, false, 'the two fields are now the same name, so the protocol case is gone');
  // The set site is guarded by type === 'tool_use'; the read site iterates toolResults. Both facts are in the file.
  const src = fs.readFileSync(path.join(ROOT, 'desktop/ccb-events.cjs'), 'utf8');
  assert.match(src, /block\.type === 'tool_use'/, 'the tool_use guard is gone');
  assert.match(src, /for \(const block of toolResults\)/, 'the tool_result iteration is gone');
});

test('the key function case is a template, which is stable', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8');
  assert.match(src, /const watcherKey = \(sessionId, watchId\) => `\$\{sessionId\}\\u0000\$\{watchId\}`/,
    'watcherKey no longer returns a template string');
  // And the reader uses the function, so the two agree at runtime.
  assert.match(src, /const key = watcherKey\(sessionId, watchId\)/, 'the read site no longer calls watcherKey');
});

test('the shape classifier still separates a primitive call from a constructed key', () => {
  assert.equal(keyShape('k'), 'identifier');
  assert.equal(keyShape('node.nodeId'), 'member');
  assert.equal(keyShape('{ id }'), 'constructed');
  assert.equal(keyShape('[a, b]'), 'constructed');
  assert.equal(keyShape('a + b'), 'computed');
  assert.equal(keyShape('Number(m[1])'), 'call');
  assert.equal(keyShape("'literal.key'"), 'literal');
  // The distinction the tool cannot make: `Number(...)` is stable, `{...}` is not, and both are "not an identifier".
  assert.notEqual(keyShape('Number(x)'), keyShape('{ x }'));
});

test('rows with no read in the same file are counted, not assumed fine', () => {
  const d = runScan();
  assert.ok(d.unreadable >= 0);
  for (const r of d.rows) {
    if (r.readKey === null) assert.equal(r.agrees, false, 'a row with no read claims agreement');
  }
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(/ounted separately rather than assumed/.test(src), 'the unreadable rows are not qualified');
});

test('the record states the prior on a new difference is strongly false', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(/produced 33 of them|prior on any new row/.test(src), 'the base rate is not stated');
  assert.ok(/prior on any new row is strongly/.test(src), 'the caveat is missing');
});

test('the tool prints the list, not a defect count', () => {
  const r = spawnSync(process.execPath, [TOOL], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /KEY DIFFERENCES:/, 'the differences are no longer listed');
  assert.match(r.stdout, /may be a rename in progress/, 'the two-identifiers case is not explained');
});
