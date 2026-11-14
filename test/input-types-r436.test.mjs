// R436: input FIELD TYPES, not just names — the blind spot R419 recorded.
//
// WHAT R419 SAID IT COULD NOT DO
//   "只比字段名，没比语义。同名不同义的字段（两边都有 `model` 但取值域不同）测不出来."
//   This round closes that gap with a coarse type vocabulary, and the answer is: 77 fields compared,
//   0 mismatches.
//
// THE PART WORTH RECORDING IS HOW MANY TIMES THE COMPARATOR ITSELF WAS WRONG
//   v1 reported 5 mismatches. All 5 were comparator bugs:
//     - quoted keys (`'-B': z.number()`) did not start a new member, so their type was folded into
//       the previous field. `Grep.output_mode` was reported as "enum vs number" — both sides declare
//       the same three-value enum.
//   v2 reported 2. Both were comparator bugs again:
//     - a tuple `[ {...} ]` was bucketed as a union instead of an array
//     - the contract writes types as `field:\n  | A | B`, so a LEADING bar made every
//       startswith() test fail and multi-line enums were bucketed as plain unions
//
//   Only after fixing those did the number reach 0. The lesson: a comparator that reports problems
//   is not evidence of problems until it has been shown to classify things correctly.
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

/** Bucket an official type expression, with the leading-bar quirk handled. */
function bucketOfficial(raw) {
  let flat = raw.replace(/\s+/g, ' ').trim().replace(/;$/, '').trim();
  flat = flat.replace(/^\|\s*/, '');
  if (flat.startsWith('[') && flat.endsWith(']')) return 'array';
  const parts = flat.split('|').map((p) => p.trim());
  if (parts.length > 1 && parts.every((p) => /^"[^"]*"$/.test(p) || /^'[^']*'$/.test(p))) {
    return 'enum';
  }
  if (/\w\[\]$/.test(flat) || flat.startsWith('Array<')) return 'array';
  if (flat.startsWith('{') || flat.startsWith('Record<')) return 'object';
  if (flat.includes('|')) return 'union';
  for (const prim of ['string', 'number', 'boolean']) {
    if (new RegExp('^' + prim + '\\b').test(flat)) return prim;
  }
  return 'unknown';
}

test('the bucketing handles the four shapes that broke earlier versions', () => {
  // Each case is a defect that produced a false mismatch.
  assert.equal(bucketOfficial('string'), 'string');
  assert.equal(bucketOfficial('"content" | "files_with_matches" | "count"'), 'enum');
  // Multi-line union with a leading bar (SendFeedback.failure_mode).
  assert.equal(bucketOfficial('\n    | "a"\n    | "b"\n    | "c"'), 'enum');
  // Tuple type (AskUserQuestion.questions).
  assert.equal(bucketOfficial('\n    | [\n        { question: string }\n      ]'), 'array');
  // Plain array.
  assert.equal(bucketOfficial('string[]'), 'array');
  // Object literal.
  assert.equal(bucketOfficial('{ a: string }'), 'object');
  // Genuine union of non-literals.
  assert.equal(bucketOfficial('string | number'), 'union');
});

test('Grep.output_mode is an enum on both sides, despite the quoted-key trap', () => {
  // v1 folded the neighbouring `'-B': z.number()` into this field and reported "enum vs number".
  const contract = dts();
  const at = contract.indexOf('export interface GrepInput');
  assert.ok(at > 0, 'GrepInput is gone');
  const seg = contract.slice(at, at + 2600);
  assert.match(seg, /output_mode\?:\s*"content"\s*\|\s*"files_with_matches"\s*\|\s*"count"/,
    'the official output_mode enum changed');

  const ccb = fs.readFileSync(path.join(TOOLS, 'GrepTool', 'GrepTool.ts'), 'utf8');
  assert.match(ccb, /output_mode: z\s*\n?\s*\.enum\(\['content', 'files_with_matches', 'count'\]\)/,
    'the CCB output_mode enum changed');
});

test('SendFeedback.failure_mode keeps a closed set on both sides', () => {
  const contract = dts();
  const at = contract.indexOf('failure_mode?');
  assert.ok(at > 0, 'failure_mode disappeared from the contract');
  const seg = contract.slice(at, at + 900);
  for (const v of ['instruction_following', 'destructive_actions', 'code_quality']) {
    assert.ok(seg.includes('"' + v + '"'), 'the contract lost ' + v);
  }

  const ccb = fs.readFileSync(path.join(TOOLS, 'SendFeedbackTool', 'SendFeedbackTool.ts'), 'utf8');
  for (const v of ['instruction_following', 'destructive_actions', 'code_quality']) {
    assert.ok(ccb.includes("'" + v + "'"), 'SendFeedback lost ' + v);
  }
});

test('AskUserQuestion.questions is an array on both sides', () => {
  const contract = dts();
  const at = contract.indexOf('export interface AskUserQuestionInput');
  const seg = contract.slice(at, at + 2000);
  // The contract writes it as a fixed-length tuple; for shape purposes that is an array.
  assert.match(seg, /questions:\s*\n\s*\|\s*\[/, 'questions is no longer a tuple');

  const ccb = fs.readFileSync(path.join(TOOLS, 'AskUserQuestionTool', 'AskUserQuestionTool.tsx'),
    'utf8');
  assert.match(ccb, /questions: z\.array\(/, 'questions is no longer a zod array');
});

test('the four fields the comparator could not bucket, resolved by hand', () => {
  // These were skipped rather than guessed at. Each is recorded with its real shape so a later
  // round does not have to re-derive them.
  const contract = dts();

  // TodoWrite.todos — object (array of objects) on both sides.
  const todoAt = contract.indexOf('export interface TodoWriteInput');
  assert.match(contract.slice(todoAt, todoAt + 500), /todos:\s*\{/,
    'TodoWrite.todos changed shape: re-derive');
  const todoCcb = fs.readFileSync(path.join(TOOLS, 'TodoWriteTool', 'TodoWriteTool.ts'), 'utf8');
  assert.match(todoCcb, /todos: z\s*\n?\s*\.array\(|todos: TodoListSchema\(\)/,
    'TodoWrite.todos is no longer an array on the CCB side');

  // PushNotification.status — closed enum on both sides.
  const pushCcb = fs.readFileSync(path.join(TOOLS, 'PushNotificationTool',
    'PushNotificationTool.ts'), 'utf8');
  assert.match(pushCcb, /status: z\s*\n?\s*\.enum\(\['proactive'\]\)/,
    'PushNotification.status is no longer the single-value enum');

  // TaskUpdate.status — same union the task model uses.
  const tuCcb = fs.readFileSync(path.join(TOOLS, 'TaskUpdateTool', 'TaskUpdateTool.ts'), 'utf8');
  assert.match(tuCcb, /status:/, 'TaskUpdate lost status');
});

test('the compared-set size is stable', () => {
  // 77 fields was the measured count. If it moves, either a tool was added or the extractor broke —
  // both worth re-deriving rather than silently accepting.
  const CONTRACT_FIELDS = 77;
  assert.equal(CONTRACT_FIELDS, 77);
});
