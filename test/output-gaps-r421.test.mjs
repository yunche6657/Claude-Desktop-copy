// R421: the 13 output gaps, verified one by one; and the one false gap.
//
// WHAT R420 GOT WRONG
//   It reported `CronList` missing `jobs` and "extra" id/humanSchedule/recurring/durable. Those
//   extra names were the tell: they belong to CronCreate. The cause is that
//   `ScheduleCronTool/` holds THREE tools (CronCreate, CronDelete, CronList), each with its own
//   `const outputSchema`, and a directory scan by filename took the first one it found.
//
//   Looking at "extra" fields is how the error surfaced. R420 had recorded those extras as real.
//
// THE PATTERN ACROSS FIVE FALSE GAPS
//   R416 Artifact   — interface name vs runtime name
//   R419 AskUserQuestion — spread overwrote a literal key
//   R419 ExitPlanMode    — multi-file directory, wrong file
//   R420 Glob       — a typo in the gate itself (`filename` vs `filenames`)
//   R421 CronList   — multi-tool directory, wrong file
//
//   Three of five are "read the wrong object". That is the failure mode to guard against, not
//   field-name comparison.
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

/** Output keys of ONE named file — never a directory scan, since one dir can hold several tools. */
function outputKeysIn(toolDir, fileName) {
  const p = path.join(TOOLS, toolDir, fileName);
  assert.ok(fs.existsSync(p), 'source missing: ' + toolDir + '/' + fileName);
  const t = fs.readFileSync(p, 'utf8');
  const at = t.indexOf('const outputSchema');
  assert.ok(at > 0, 'no outputSchema in ' + fileName);
  const rest = t.slice(at);
  const om = /z\.(?:object|strictObject)\(\{/.exec(rest);
  assert.ok(om, 'no z.object in ' + fileName + ' outputSchema');
  let depth = 0;
  let end = -1;
  for (let i = om.index + om[0].length - 1; i < rest.length; i += 1) {
    if (rest[i] === '{') depth += 1;
    else if (rest[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = rest.slice(om.index + om[0].length, end);
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

test('CronList DOES have `jobs` — R420 read the wrong file', () => {
  // The false gap. Three tools share one directory; a filename-order scan took CronCreate's schema.
  assert.deepEqual(officialOut('CronList'), ['jobs']);

  const keys = outputKeysIn('ScheduleCronTool', 'CronListTool.ts');
  assert.ok(keys.includes('jobs'),
    'CronList no longer declares jobs: re-derive the R421 correction');

  // The tell that exposed the error: CronCreate-only names must NOT appear in CronList's own file.
  for (const other of ['humanSchedule', 'recurring', 'durable']) {
    assert.ok(!keys.includes(other),
      'CronList now declares ' + other + ', which used to be CronCreate-only. If the tools were '
      + 'merged, the R421 correction no longer applies.');
  }
});

test('the shared directory really does hold three tools', () => {
  // The precondition for the false gap. If it ever splits, the trap is gone.
  const dir = path.join(TOOLS, 'ScheduleCronTool');
  const files = fs.readdirSync(dir).filter((f) => /^Cron\w+Tool\.ts$/.test(f)).sort();
  assert.deepEqual(files, ['CronCreateTool.ts', 'CronDeleteTool.ts', 'CronListTool.ts'],
    'the cron tool directory changed shape: re-derive how many schemas it holds');
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(t, /const outputSchema/, f + ' lost its own outputSchema');
  }
});

test('the confirmed gaps each remain real, read from the correct file', () => {
  // One row per verified gap. Reading a specific FILE, never a directory.
  const CASES = [
    ['AskUserQuestion', 'AskUserQuestionTool', 'AskUserQuestionTool.tsx', ['response', 'afkTimeoutMs']],
    ['CronCreate', 'ScheduleCronTool', 'CronCreateTool.ts', ['nextFireAt']],
    ['FileEdit', 'FileEditTool', 'types.ts', ['staged']],
    // R433 wired userModified (the context already carried it). staged still has no
    // staging source in either file tool.
    ['FileWrite', 'FileWriteTool', 'FileWriteTool.ts', ['staged']],
    // R427 closed all three: `totalMatches` came from a length glob.ts already computed,
    // `countIsComplete` is the negation of the timeout, and `timedOut` was the discarded signal.
    // R424 closed `timedOut`, R428 closed the two totals — taken from applyHeadLimit's unsliced
    // length rather than a new count pass. Grep no longer has an output gap.

    // R430 closed WebSearch.searchCount (UI.tsx already computed it), R431 closed
    // NotebookEdit.old_source (captured before the edit destroys it), and R432 closed
    // ReadMcpResource.error — scoped to a failed `resources/read` only; the three caller-error
    // checks still throw. None of those three tools has an output gap now.
  ];
  for (const [iface, dir, file, missing] of CASES) {
    const off = officialOut(iface);
    const ccb = outputKeysIn(dir, file);
    for (const k of missing) {
      assert.ok(off.includes(k), iface + 'Output lost ' + k);
      assert.ok(!ccb.includes(k),
        iface + ' gained ' + k + ': the gap closed, update evidence/output-gaps-verified-r421.md');
    }
  }

  // R424 added `timedOut`; R428 added `totalFiles` / `totalLines`. Assert all three positively so a
  // regression is visible here rather than only in the Grep-specific tests.
  const grep = fs.readFileSync(path.join(TOOLS, 'GrepTool', 'GrepTool.ts'), 'utf8');
  for (const k of ['timedOut', 'totalFiles', 'totalLines']) {
    assert.ok(grep.includes(k), 'Grep lost ' + k + ': the output gap reopened');
  }

  // R427 closed all three Glob gaps. Asserting positively keeps a regression visible; the
  // `!ccb.includes` form above would pass silently if the file were deleted.
  const globTool = fs.readFileSync(path.join(TOOLS, 'GlobTool', 'GlobTool.ts'), 'utf8');
  for (const k of ['totalMatches', 'countIsComplete', 'timedOut']) {
    assert.ok(globTool.includes(k), 'Glob lost ' + k + ': the R427 fix regressed');
  }

  // R430 / R431 / R432 closed the last three single-field gaps. Same reasoning: assert present.
  for (const [dir, file, fields] of [
    ['WebSearchTool', 'WebSearchTool.ts', ['searchCount']],
    ['NotebookEditTool', 'NotebookEditTool.ts', ['old_source']],
    ['ReadMcpResourceTool', 'ReadMcpResourceTool.ts', ['error']],
  ]) {
    const s = fs.readFileSync(path.join(TOOLS, dir, file), 'utf8');
    for (const k of fields) {
      assert.ok(s.includes(k), dir + ' lost ' + k + ': the gap reopened');
    }
  }
});

test('Monitor, RemoteTrigger and WebFetch have both gaps and extras', () => {
  // These three are not simple omissions: CCB substitutes a different field for the official one.
  // `Monitor` gives outputFile where the contract wants timeoutMs/persistent; `RemoteTrigger` gives
  // audit_id where the contract wants summary. That is a shape difference, not a missing key.
  const monitor = outputKeysIn('MonitorTool', 'MonitorTool.tsx');
  assert.ok(monitor.includes('outputFile'), 'Monitor lost outputFile');
  for (const k of ['timeoutMs', 'persistent']) {
    assert.ok(!monitor.includes(k), 'Monitor gained ' + k + ': revisit R406/R409');
  }

  const remote = outputKeysIn('RemoteTriggerTool', 'RemoteTriggerTool.ts');
  assert.ok(remote.includes('audit_id'), 'RemoteTrigger lost audit_id');
  assert.ok(!remote.includes('summary'), 'RemoteTrigger gained summary: revisit §1');

  const web = outputKeysIn('WebFetchTool', 'WebFetchTool.ts');
  assert.ok(web.includes('contentOffset') && web.includes('contentLength'),
    'WebFetch lost the two fields added in R405');
  assert.ok(!web.includes('artifactRead'), 'WebFetch gained artifactRead: revisit R405');
});

test('the three tools that lacked an outputSchema all have one now', () => {
  // R421 listed three: ProposeGoal, PushNotification, SendFeedback. R422 fixed SendFeedback and
  // R423 fixed the other two, so nothing is left in this category. Asserting the positive keeps a
  // regression visible — an `!includes` check would pass silently if the file were deleted.
  const FIXED = [
    ['SendFeedbackTool', 'SendFeedbackTool.ts'],
    ['ProposeGoalTool', 'ProposeGoalTool.ts'],
    ['PushNotificationTool', 'PushNotificationTool.ts'],
  ];
  for (const [dir, file] of FIXED) {
    const t = fs.readFileSync(path.join(TOOLS, dir, file), 'utf8');
    assert.match(t, /const outputSchema = lazySchema\(\(\) =>/,
      dir + ' lost the outputSchema added in R422/R423');
  }
});
