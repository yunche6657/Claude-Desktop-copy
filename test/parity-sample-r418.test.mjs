// R418: sampled field parity for tools that are "present" by name.
//
// THE QUESTION
//   R417 settled coverage at 34 of 44 official interfaces. But `Artifact` is a counterexample to
//   reading that as capability parity: the official tool has 20 fields and 13 actions, CCB's
//   `artifact` has 3 fields and no actions. If that were typical, "34/44" would measure almost
//   nothing.
//
// THE ANSWER, SAMPLED
//   6 of 7 sampled tools declare exactly the official input fields. The one gap is `Monitor.ws`,
//   which R406/R409 had already recorded as blocked on a WebSocket transport. So `Artifact` is an
//   outlier, not the pattern.
//
// WHAT THIS FILE GUARDS
//   The three analysis mistakes made while producing that answer, because each would have
//   produced a false parity gap:
//     1. reading only the FIRST schema object  -> reported Agent missing 4 fields it has
//     2. scanning every z.object in the dir    -> counted OUTPUT keys as extra INPUT fields
//     3. treating `_simulatedSedEdit` as public -> it is commented "Always omit ... from the
//        model-facing schema"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');

const dts = () => fs.readFileSync(DTS, 'utf8');

/** Official input field names for one interface. */
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

test('WebFetch, TodoWrite and PushNotification declare exactly the official fields', () => {
  // These three are the cleanest cases: a single schema object per tool, no composition.
  const cases = [
    ['WebFetch', 'WebFetchTool', ['url', 'prompt', 'offset']],
    ['TodoWrite', 'TodoWriteTool', ['todos']],
    ['PushNotification', 'PushNotificationTool', ['message', 'status']],
  ];
  for (const [iface, dir, expected] of cases) {
    assert.deepEqual(officialKeys(iface).sort(), [...expected].sort(),
      iface + ': the official field set changed');

    // And the CCB schema contains each of them as a top-level key.
    const f = path.join(TOOLS, dir, dir + '.ts');
    const alt = path.join(TOOLS, dir, dir + '.tsx');
    const file = fs.existsSync(f) ? f : alt;
    assert.ok(fs.existsSync(file), dir + ' source missing');
    const src = fs.readFileSync(file, 'utf8');
    const missing = expected.filter((k) => !new RegExp('^\\s{4}' + k + '\\??:', 'm').test(src));
    assert.deepEqual(missing, [], iface + ' lost a top-level input field');
  }
});

test('SendFeedback matches its own official contract exactly', () => {
  // Added this session (R412); it is the one tool where a mismatch would be entirely my fault.
  const official = officialKeys('SendFeedback').sort();
  assert.deepEqual(official,
    ['area', 'details', 'failure_mode', 'task_category', 'title', 'type'],
    'the SendFeedback interface changed');

  const src = fs.readFileSync(
    path.join(TOOLS, 'SendFeedbackTool', 'SendFeedbackTool.ts'), 'utf8',
  );
  const missing = official.filter((k) => !new RegExp('^\\s{4}' + k + ':', 'm').test(src));
  assert.deepEqual(missing, [], 'SendFeedback is missing a field it declares in the contract');
});

test('Monitor is the one sampled tool with a real gap, and it is the known one', () => {
  // `ws` was recorded as blocked in R406/R409: it needs a WebSocket transport the tool lacks.
  // Sampling reproduced that independently, which is why the sample is trustworthy.
  const official = officialKeys('Monitor').sort();
  assert.deepEqual(official, ['command', 'description', 'timeout_ms', 'ws'],
    'the Monitor interface changed');

  const src = fs.readFileSync(path.join(TOOLS, 'MonitorTool', 'MonitorTool.tsx'), 'utf8');
  for (const present of ['command', 'description', 'timeout_ms']) {
    assert.ok(new RegExp('^\\s{4}' + present + '\\??:', 'm').test(src),
      'Monitor lost ' + present);
  }
  // If `ws` ever appears, the §1 blocker is resolved and this test should be updated.
  assert.ok(!/^\s{4}ws\??:/m.test(src),
    'Monitor gained `ws`: the WebSocket transport now exists, revisit §1');
});

test('Agent composes its schema, so a first-object-only read is wrong', () => {
  // Mistake 1. `AgentTool` builds its input from
  //   baseInputSchema().merge(multiAgentInputSchema).extend({ isolation, cwd })
  // Reading only the first object reports name/team_name/mode/isolation missing — contradicting
  // R405, which verified all four.
  const src = fs.readFileSync(path.join(TOOLS, 'AgentTool', 'AgentTool.tsx'), 'utf8');
  assert.match(src, /\.merge\(multiAgentInputSchema\)/,
    'the merge composition is gone: a first-object-only read would now be correct, re-derive R405');
  for (const field of ['name', 'team_name', 'mode', 'isolation']) {
    assert.ok(src.includes(field + ':'), 'Agent lost ' + field);
  }
  // The official set must still be coverable by the composed schema.
  const official = officialKeys('Agent');
  assert.equal(official.length, 10, 'the Agent interface changed size');
});

test('output keys are not input keys — the second analysis mistake', () => {
  // Mistake 2. Scanning every z.object in a tool directory pulls in result shapes:
  // Bash has stdout/stderr, Monitor has taskId/outputFile, TodoWrite has oldTodos/newTodos.
  // Counting those as "extra input fields" invents a parity gap that does not exist.
  const bash = fs.readFileSync(path.join(TOOLS, 'BashTool', 'BashTool.tsx'), 'utf8');
  for (const outKey of ['stdout', 'stderr']) {
    assert.ok(bash.includes(outKey), 'Bash output shape changed; re-derive the sample');
  }
  // The real input schema for Bash has exactly the official five.
  assert.deepEqual(officialKeys('Bash').sort(),
    ['command', 'dangerouslyDisableSandbox', 'description', 'run_in_background', 'timeout'],
    'the Bash interface changed');
});

test('`_simulatedSedEdit` is internal, not a public extra field — the third mistake', () => {
  // Mistake 3. It appears in the Bash schema, so a naive scan calls it an extra model-facing
  // field. The source says otherwise.
  const bash = fs.readFileSync(path.join(TOOLS, 'BashTool', 'BashTool.tsx'), 'utf8');
  assert.ok(bash.includes('_simulatedSedEdit'), '_simulatedSedEdit disappeared; re-derive');
  assert.match(bash, /Always omit _simulatedSedEdit from the model-facing schema/,
    'the comment that justifies excluding it is gone: re-check whether it is now public');
});

test('Artifact is the outlier, and stays recognisably different', () => {
  // The reason the sampled answer matters: one tool, not the pattern.
  const official = officialKeys('Artifact');
  assert.equal(official.length, 20, 'the Artifact interface changed size');

  const ccb = fs.readFileSync(path.join(TOOLS, 'ArtifactTool', 'ArtifactTool.ts'), 'utf8');
  const ccbKeys = ['file_path', 'hash', 'ttl'].filter((k) =>
    new RegExp('^\\s{4}' + k + ':', 'm').test(ccb));
  assert.equal(ccbKeys.length, 3,
    'the CCB artifact tool changed shape: re-derive whether it still is the outlier');
  // The 20-field gap is not a missing-field oversight; it is a different capability set.
  assert.ok(!ccb.includes('upload_asset'), 'artifact gained asset actions: §3.4 may be doable now');
});
