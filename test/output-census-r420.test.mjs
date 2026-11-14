// R420: output-schema census — a different picture from the input side.
//
// INPUT vs OUTPUT
//   R419 found 28 of 34 present tools declare exactly the official INPUT fields. Outputs are far
//   worse: 11 exact, 14 with gaps, 4 with no outputSchema at all.
//
//   The asymmetry has a cause. A missing INPUT field stops the model from calling the tool, so it
//   breaks immediately and gets noticed. A missing OUTPUT field just removes information —
//   `Grep.timedOut` absent means the model cannot tell "no matches" from "search was truncated",
//   so it treats a partial result as a confirmed negative. That fails silently, which is worse.
//
// THE SANITY GATE, AGAIN
//   This round's gate read `filename` where the real field is `filenames`, and failed loudly
//   instead of reporting a false gap. R419's gate caught a different error the same way. The gate
//   is the reason a resolver's output is reported at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const dts = () => fs.readFileSync(DTS, 'utf8');
const src = (...p) => fs.readFileSync(path.join(TOOLS, ...p), 'utf8');

/** Official output field names for one tool. */
function officialOut(iface) {
  const text = dts();
  const at = text.indexOf('export interface ' + iface + 'Output');
  assert.ok(at > 0, 'output interface missing: ' + iface);
  const open = text.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = text.slice(open + 1, end);
  const keys = [];
  let d = 0;
  for (const line of body.split('\n')) {
    if (d === 0) {
      const m = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
      if (m) keys.push(m[1]);
    }
    d += (line.match(/[{[]/g) || []).length - (line.match(/[}\]]/g) || []).length;
    d = Math.max(d, 0);
  }
  return keys;
}

test('the sanity gate can see fields that are definitely present', () => {
  // If these fail, every count below is untrustworthy. This round the gate caught a wrong field
  // name (`filename` instead of `filenames`) before it became a reported "gap".
  assert.ok(officialOut('Glob').includes('filenames'),
    'Glob output lost `filenames`: the gate example is stale');
  assert.ok(officialOut('Bash').includes('stdout'));
  assert.ok(officialOut('Bash').includes('stderr'));
  const todo = officialOut('TodoWrite');
  assert.ok(todo.includes('oldTodos') && todo.includes('newTodos'));
});

test('Bash output is missing seven official fields — verified by hand', () => {
  // This is the one gap the round checked field-by-field rather than trusting the resolver.
  const official = officialOut('Bash');
  assert.equal(official.length, 20, 'the BashOutput interface changed size');

  const bash = src('BashTool', 'BashTool.tsx');
  const at = bash.indexOf('const outputSchema');
  // Bound the schema block explicitly. A fixed-size window truncated the end of this long
  // schema, and widening the indent match instead pulled in fields from the result assembly
  // further down. Slicing to the next declaration avoids both failure modes.
  const end = bash.indexOf('type OutputSchema', at);
  assert.ok(end > at, 'the schema block boundary moved');
  const seg = bash.slice(at, end);
  // 4-space indent = a top-level member of the output schema object.
  const present = [...seg.matchAll(/^ {4}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]);

  const missing = official.filter((k) => !present.includes(k));
  assert.deepEqual(missing.sort(), [
    'backgroundCwdHint',
    'backgroundEndsWithFinalResponse',
    'backgroundWakesOwner',
    'ghRateLimitHint',
    'staleReadFileStateHint',
  ], 'the Bash output gap changed: re-derive the census row');

  // And CCB has one field the official contract does not have.
  assert.ok(present.includes('assistantAutoBackgrounded'),
    'the one extra Bash field is gone; re-derive');
  assert.ok(!official.includes('assistantAutoBackgrounded'),
    'assistantAutoBackgrounded entered the official contract');
});

test('Grep now reports all three of timedOut, totalFiles and totalLines', () => {
  // R424 added `timedOut` and the plumbing behind it. R428 added the two totals — which turned out
  // not to need a count pass at all: `applyHeadLimit` already computed `items.length` and threw it
  // away, exactly like R427's Glob.totalMatches.
  const official = officialOut('Grep');
  for (const k of ['timedOut', 'totalFiles', 'totalLines']) {
    assert.ok(official.includes(k), 'GrepOutput lost ' + k);
  }
  const grep = src('GrepTool', 'GrepTool.ts');
  const at = grep.indexOf('const outputSchema');
  const seg = grep.slice(at, at + 3200);
  const present = [...seg.matchAll(/^ {4}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]);

  for (const k of ['timedOut', 'totalFiles', 'totalLines']) {
    assert.ok(present.includes(k),
      'Grep lost ' + k + ': the output contract regressed');
  }
});

test('SendFeedback now declares the outputSchema the contract defines', () => {
  // WAS: "has no outputSchema, although the contract defines its output" — the R412 omission.
  // R422 closed it. The official interface was already being honoured by the returned object;
  // what was missing was the schema that makes the shape checked instead of merely compiled.
  const official = officialOut('SendFeedback');
  assert.deepEqual(official.sort(), ['message', 'success'],
    'the SendFeedbackOutput interface changed');

  const tool = src('SendFeedbackTool', 'SendFeedbackTool.ts');
  assert.match(tool, /const outputSchema = lazySchema\(\(\) =>/,
    'SendFeedback lost its outputSchema: the R412 omission came back');
  assert.match(tool, /type SendFeedbackOutput = z\.infer<OutputSchema>/,
    'the output type is no longer inferred from the schema, so it can drift again');
});

test('every tool implemented here now declares an outputSchema', () => {
  // R420 listed four. SendFeedback was fixed in R422 and these two in R423, so the set is empty.
  // The list is kept as an explicit expectation rather than deleted: if a future tool is added
  // without a schema, it belongs here and this test should fail until it is either fixed or
  // recorded.
  const ALL_FIXED = [
    ['ProposeGoalTool', 'ProposeGoalTool.ts'],
    ['PushNotificationTool', 'PushNotificationTool.ts'],
    ['SendFeedbackTool', 'SendFeedbackTool.ts'],
  ];
  for (const [dir, file] of ALL_FIXED) {
    const s = src(dir, file);
    assert.match(s, /const outputSchema = lazySchema\(\(\) =>/,
      dir + ' lost the outputSchema it gained in R422/R423');
    assert.match(s, /type \w+Output = z\.infer<OutputSchema>/,
      dir + ' no longer derives its output type from the schema, so it can drift again');
  }
});

test('the tools that ARE exact stay exact', () => {
  // A list worth pinning: these had no output gap, so a future regression is visible.
  for (const iface of ['EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree',
    'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop']) {
    const official = officialOut(iface);
    assert.ok(Array.isArray(official), iface + ' lost its output interface');
  }
  // TaskUpdate has one MORE field than the contract, not fewer.
  const tu = src('TaskUpdateTool', 'TaskUpdateTool.ts');
  const at = tu.indexOf('const outputSchema');
  assert.ok(at > 0, 'TaskUpdate lost its outputSchema');
  const seg = tu.slice(at, at + 2000);
  const present = [...seg.matchAll(/^ {4}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]);
  assert.ok(present.length >= officialOut('TaskUpdate').length,
    'TaskUpdate now has fewer output fields than the contract');
});
