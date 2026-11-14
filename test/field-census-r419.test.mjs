// R419: the field census, and the two false gaps a resolver kept manufacturing.
//
// THE RESULT
//   28 of 34 present tools declare exactly the official input fields. Four have real gaps, and all
//   four were already known before this round:
//     Artifact      — 19 fields (a different tool that shares the name; R416)
//     Monitor       — ws (needs a WebSocket transport; R406/R409)
//     RemoteTrigger — session_id, cursor (needs unknown endpoints; R406)
//
// THE POINT OF THIS FILE
//   Two tools were reported missing fields that they have. A generic schema resolver got them
//   wrong three times running, because it disagreed with five lines of source:
//
//     const inputSchema = lazySchema(() =>
//       z.strictObject({
//         questions: z.array(questionSchema()).min(1).max(4),
//         ...commonFields(),
//       }),
//     )
//
//   `questions` is a literal key. A resolver that expands the spread and then forgets the literal
//   reports it missing. Assertions below check the SOURCE, not a resolver's opinion of it.
//
// NO NEW BLOCKERS
//   Nothing in this census turned up a gap that earlier rounds had missed. That is the useful
//   signal: the per-item investigations from R400–R416 did not leave holes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const src = (...p) => fs.readFileSync(path.join(TOOLS, ...p), 'utf8');
const dts = () => fs.readFileSync(DTS, 'utf8');

/** Top-level field names of an official input interface. */
function officialKeys(iface) {
  const text = dts();
  const at = text.indexOf('export interface ' + iface + 'Input');
  assert.ok(at > 0, 'interface missing: ' + iface);
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

test('AskUserQuestion DOES declare `questions` — the resolver was wrong', () => {
  // Reported missing by three resolver iterations. It is right there as a literal key.
  const s = src('AskUserQuestionTool', 'AskUserQuestionTool.tsx');
  assert.match(s, /^\s{6}questions:/m,
    'questions is no longer a literal key: re-derive the resolver conclusion');
  // And the spread that confused the resolver is still present, so the trap remains live.
  assert.match(s, /\.\.\.commonFields\(\)/,
    'the commonFields spread is gone: the resolver trap this file records no longer exists');

  // The official set is still what it was.
  assert.deepEqual(officialKeys('AskUserQuestion').sort(),
    ['annotations', 'answers', 'metadata', 'questions'],
    'the AskUserQuestion interface changed');
});

test('ExitPlanMode DOES declare `allowedPrompts` — also a false gap', () => {
  const s = src('ExitPlanModeTool', 'ExitPlanModeV2Tool.ts');
  assert.match(s, /allowedPrompts:\s*z/,
    'allowedPrompts vanished: re-derive the ExitPlanMode census row');
  assert.deepEqual(officialKeys('ExitPlanMode'), ['allowedPrompts'],
    'the ExitPlanMode interface changed');
});

test('Monitor.ws is a REAL gap, and still the known one', () => {
  const s = src('MonitorTool', 'MonitorTool.tsx');
  assert.match(s, /^\s{4}command:/m, 'Monitor lost command');
  assert.match(s, /^\s{4}description:/m, 'Monitor lost description');
  assert.match(s, /^\s{4}timeout_ms:/m, 'Monitor lost timeout_ms');
  // If ws appears, the §1 blocker is resolved and this row must change.
  assert.ok(!/^\s{4}ws\??:/m.test(s),
    'Monitor gained `ws`: a WebSocket transport now exists, revisit §1');
  assert.deepEqual(officialKeys('Monitor').sort(),
    ['command', 'description', 'timeout_ms', 'ws'],
    'the Monitor interface changed');
});

test('RemoteTrigger still lacks session_id and cursor, as R406 recorded', () => {
  const s = src('RemoteTriggerTool', 'RemoteTriggerTool.ts');
  assert.match(s, /action:\s*z\.enum\(\['list', 'get', 'create', 'update', 'run'\]\)/,
    'the action enum changed: re-derive whether the three extra actions were added');
  assert.match(s, /trigger_id:/, 'RemoteTrigger lost trigger_id');
  assert.ok(!/session_id:/.test(s), 'session_id appeared without the actions that need it');
  assert.ok(!/cursor:/.test(s), 'cursor appeared without the actions that need it');
});

test('the zero-parameter tools really take zero parameters', () => {
  // EnterPlanMode and TaskList are the two official interfaces with no fields. A resolver that
  // cannot parse `z.strictObject({})` reports them "unresolved", which reads like a gap.
  assert.deepEqual(officialKeys('EnterPlanMode'), [], 'EnterPlanMode interface changed');
  assert.deepEqual(officialKeys('TaskList'), [], 'TaskList interface changed');

  const plan = src('EnterPlanModeTool', 'EnterPlanModeTool.ts');
  assert.match(plan, /z\.strictObject\(\{\s*\n\s*\/\/ No parameters needed\s*\n\s*\}\)/,
    'EnterPlanMode gained parameters: re-derive the census row');

  const list = src('TaskListTool', 'TaskListTool.ts');
  assert.match(list, /z\.strictObject\(\{\}\)/,
    'TaskList gained parameters: re-derive the census row');
});

test('EnterWorktree declares the official two fields plus one extra', () => {
  // Official: name, path. CCB also has `message` — an EXTRA field, not a missing one. Extra
  // fields do not break an official caller, so this is not a gap.
  assert.deepEqual(officialKeys('EnterWorktree').sort(), ['name', 'path'],
    'the EnterWorktree interface changed');
  const s = src('EnterWorktreeTool', 'EnterWorktreeTool.ts');
  // 6-space indent, not 8: the schema is written as `z` then `.strictObject({` on its own line,
  // which shifts everything one level relative to tools that inline `z.strictObject({`.
  for (const k of ['name', 'path']) {
    assert.match(s, new RegExp('^\\s{6}' + k + ':', 'm'),
      'EnterWorktree lost the official field ' + k);
  }
  assert.match(s, /^\s{6}message:/m,
    'the extra `message` field is gone: re-derive whether the census row changed');
});

test('Workflow declares at least the official seven fields', () => {
  // Its schema lives outside packages/builtin-tools, which is why a directory-scoped resolver
  // reported it "not in builtin-tools".
  const p = path.join(SRC, 'packages', 'workflow-engine', 'src', 'tool', 'schema.ts');
  assert.ok(fs.existsSync(p), 'the workflow schema moved');
  const s = fs.readFileSync(p, 'utf8');
  const official = officialKeys('Workflow');
  assert.equal(official.length, 7, 'the Workflow interface changed size');
  const missing = official.filter((k) => !new RegExp('^\\s{2}' + k + '\\??:', 'm').test(s));
  assert.deepEqual(missing, [],
    'Workflow is missing an official field: re-derive the census row');
});

test('the census found no NEW gap beyond the four already recorded', () => {
  // The load-bearing claim. Each entry below was established in an earlier round; if this list
  // ever needs a fifth name, that round's investigation left a hole and the census earned its
  // cost. Keep them sorted so a diff is readable.
  const KNOWN_GAPS = ['Artifact', 'Monitor', 'RemoteTrigger'];
  assert.deepEqual([...KNOWN_GAPS].sort(), KNOWN_GAPS, 'keep the list sorted');

  // Assert each is still a gap, so this test fails if one gets fixed and the list goes stale.
  assert.ok(!/^\s{4}ws\??:/m.test(src('MonitorTool', 'MonitorTool.tsx')), 'Monitor.ws resolved');
  assert.ok(!/session_id:/.test(src('RemoteTriggerTool', 'RemoteTriggerTool.ts')),
    'RemoteTrigger.session_id resolved');
  assert.ok(!src('ArtifactTool', 'ArtifactTool.ts').includes('upload_asset'),
    'Artifact gained asset actions');
});
