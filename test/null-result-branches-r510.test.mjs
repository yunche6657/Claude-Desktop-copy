// R510: `{result:null, tool_name:X}` has SIX causes, and GoalTool's is "Remote Control 未连接".
//
// THE INCONSISTENCY HANDED OVER FROM R508/R509
//   GoalTool is discoverable by SearchExtraTools (R509 proved it), its `call()` provably returns an object on
//   every path, yet invoking it through ExecuteExtraTool yields {"result":null,"tool_name":"GoalTool"}.
//   R508 had established that this shape also appears for a nonexistent tool and concluded "the gateway produced
//   nothing". True, and it did not distinguish the causes.
//
// THE SIX BRANCHES, READ OUT OF ExecuteTool.call
//      1. !targetTool                          "Tool "X" not found. Use SearchExtraTools ..."
//      2. !discovered.has(input.tool_name)     "Tool "X" has not been discovered yet. ..."
//      3. !targetTool.isEnabled()              "工具 "X" 当前不可用：Remote Control 未连接。"
//      4. !parsed.success                      (zod validation error)
//      5. !validation.result                   "Invalid parameters for tool "X": ..."
//      6. permResult.behavior === "deny"       "Permission denied for tool "X": ..."
//   All six return the identical `data` shape. The discriminator is the accompanying `newMessages` text, which a
//   probe reading only `data` throws away — which is exactly what R508's probe did.
//
// GOALTOOL'S CAUSE IS #3
//   Its source has no `isEnabled` of its own, so the branch is not declining on its own authority; the message
//   says Remote Control is not connected. So the null is a REMOTE-CONTROL precondition, not a missing tool and
//   not a broken call. That is a third distinct verdict in a series that already had two:
//       absent from the envelope (R507)  -> still invocable (R508)
//       discoverable (R509)             -> not necessarily callable to completion
//       callable but gated              -> ExecuteExtraTool reports null, and the reason is a connection
//
// THREE PARSER FAILURES ON THE WAY, EACH REPORTING A PLAUSIBLE NON-ANSWER
//   1. Searched for the literal `'result: null, tool_name'` and found ZERO — the bundle puts those fields on
//      separate lines. The report then printed "0 distinct branches", i.e. the shape had no causes.
//   2. Widened the window to 6000 chars and still got zero; the real cause was the single-line marker, not the
//      window. Bounded by the next buildTool definition only after reading the raw text.
//   3. Paired each guard with a message from a window that ran 900 chars FORWARD, so every row's message
//      belonged to the NEXT branch. Six guards and six messages, every pairing wrong — which looks like an
//      explanation and is worse than a bare list.
//   Plus the bundle escapes non-ASCII as \uXXXX, so the decisive message printed as unreadable escapes until
//   it was decoded. A message nobody can read is not evidence.
//
// WHAT IS NOT CLAIMED
//   Not that branch #3 is the only one GoalTool could hit — a different call could fail validation (#4/#5).
//   Not that Remote Control being unconnected is a defect: it is a configuration state this probe does not set.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'null-result-branches.cjs');

const haveAll = fs.existsSync(path.join(ROOT, 'agent-core', 'claude-code', 'dist'));

const run = () => spawnSync(process.execPath, [TOOL, '--json'], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('six distinct branches produce the same data shape', { skip: !haveAll }, () => {
  const r = run();
  assert.equal(r.status, 0, 'the tool failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);
  assert.ok(!d.error, 'the tool refused: ' + d.error);

  assert.equal(d.branches.length, 6,
    `expected six branches producing {result:null}, got ${d.branches.length}`);

  // Each guard must be one of the six the source actually has.
  const guards = d.branches.map((b) => b.guard || '');
  for (const expected of ['!targetTool', 'isEnabled', 'parsed.success', 'validation.result', 'deny']) {
    assert.ok(guards.some((g) => g.includes(expected)),
      `no branch guards on ${expected}: ` + JSON.stringify(guards));
  }
  // And they must be distinct, or the pairing collapsed.
  assert.equal(new Set(guards).size >= 5, true,
    'the guards are not distinct: the windows are overlapping again');
});

test('each message is paired with its own guard', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);
  const byGuard = (needle) => d.branches.find((b) => (b.guard || '').includes(needle));

  // The specific pairings that must hold, checked against the source's own wording.
  assert.match(byGuard('!targetTool').message, /not found/,
    'the not-found branch carries the wrong message');
  assert.match(byGuard('isEnabled').message, /Remote Control/,
    'the isEnabled branch no longer reports the Remote Control precondition');
  assert.match(byGuard('isEnabled').message, /当前不可用/,
    'the isEnabled message is not decoded: \\uXXXX escapes make it unreadable');
  assert.match(byGuard('deny').message, /Permission denied/,
    'the deny branch carries the wrong message');
});

test('GoalTool cannot decline on its own, so the null is the gateway', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);
  assert.equal(d.goalReturnsDataAlways, true,
    'GoalTool.call() now has a path that does not return an object: the gateway reading would be wrong');
});

test('the tool report names Remote Control as GoalTool\'s cause', () => {
  const r = spawnSync(process.execPath, [TOOL], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  assert.match(r.stdout, /REMOTE-CONTROL precondition/,
    'the report no longer names the cause');
  assert.match(r.stdout, /Remote Control 未连接/,
    'the report no longer quotes the decoded message');
});

test('the parser lessons are recorded', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /found ZERO occurrences/,
    'the single-line marker failure is no longer documented');
  assert.match(source, /belonged to the NEXT branch/,
    'the mis-pairing failure is no longer documented');
  assert.match(source, /A wrong pairing is worse than a bare list/,
    'the reason the pairing matters is no longer recorded');
  assert.match(source, /\\\\u\(\[0-9a-fA-F\]\{4\}\)/,
    'the \\uXXXX decoding is gone: the decisive message will be unreadable again');
  assert.match(source, /A message nobody can read is not evidence/,
    'the decoding rationale is gone');
});
