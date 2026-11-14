// R500: the eighteen "missing" contract tools are nine different statements, not one.
//
// WHAT R498/R499 LEFT OPEN
//   R498 measured 26 of 44 contract tools registered. R499 explained four of the eighteen absentees — the Task
//   family, gated by isTodoV2Enabled(). Fourteen remained with no explanation, which reads as "the build is
//   missing them".
//
// THE DISTINCTION
//   "Absent" is not one fact. Under the default flag set the seventeen absentees fall into four groups, and each
//   group says something different about the artifact:
//
//       not-in-build (9)             no directory, no mention in src/tools.ts. Genuinely not part of this build:
//                                    ClaudeDesign, OfferChromeSetup, Projects, ProposeSkills, ReadMcpResourceDir,
//                                    ReadNotifications, ReportFindings, ScheduleWakeup, ShowOnboardingRolePicker
//       renamed (5)                  the source registers a different name and the runtime HAS that name:
//                                    Agent->Task, Artifact->artifact, FileEdit->Edit, FileRead->Read,
//                                    FileWrite->Write. Not absent at all.
//       listed-not-registered (7)    unconditional in the registration block, yet not registered at runtime.
//                                    ListMcpResources, Mcp, ReadMcpResource, TodoWrite, and three more.
//                                    UNEXPLAINED — and reported as such.
//       feature-gated (2)            feature(KAIROS) for PushNotification, feature(AGENT_TRIGGERS_REMOTE) for
//                                    RemoteTrigger. Absence is a build configuration, not a gap.
//
//   So of eighteen, five are present under another name, nine are out of scope for this build, two are off by
//   build flag, and four are genuinely unexplained. Reporting "eighteen missing" collapsed all of that.
//
// TWO MISTAKES MADE AND FIXED WHILE BUILDING THIS
//   1. The first version explained all 44 contract tools. AskUserQuestion, Bash and NotebookEdit — plainly
//      registered — were labelled `listed-but-absent`. It was explaining absences that did not exist, because it
//      had no runtime baseline at all.
//   2. The second version read the raw cache file, which holds only ONE entry. After a `--tasks` run it reported
//      TodoWrite as absent from the default surface. The flag set is now named explicitly and passed through to
//      tools/runtime-tools.cjs, so the baseline cannot be inherited by accident.
//
//   And a rename rule that looked reasonable failed twice: AgentTool declares THIRTEEN names because it
//   re-exports the built-in set for subagents, so "take a registered name from this directory" produced
//   `Agent -> Bash`, then `Agent -> Edit`. Both would have been reported with confidence. The answer is `Task`,
//   established from R498's measured list, so it is recorded as evidence rather than inferred.
//
// WHAT THIS DOES NOT DO
//   It evaluates no flag. A `feature-gated` row names the flag and says nothing about its value. The
//   `listed-not-registered` group is an admitted gap, not a claim about mechanism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'tool-absence.cjs');
const SRC = path.join(ROOT, '..', '.tmp', 'ccb-src');

// Each call may spawn the CLI probe; with a warm cache this is fast.
const run = (args = []) => spawnSync(process.execPath, [TOOL, '--json', ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true,
});

const haveAll = fs.existsSync(path.join(ROOT, 'agent-core', 'bun', 'bun.exe'))
  && fs.existsSync(path.join(SRC, 'src', 'tools.ts'));

test('every absent contract tool gets a reason from the declared set', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);
  assert.ok(!d.error, 'the tool refused: ' + d.error);
  assert.equal(d.contractCount, 44, 'the contract tool count changed');

  // THE DECLARED SET WAS STALE, NOT THE TOOL
  //   R503 moved three rows out of `listed-not-registered` into `requires-mcp-server`, because a tool installed by an
  //   MCP server is not "listed but unregistered" — saying so would have been tidier and false. It also settled
  //   `template-only-name` for the one entry whose name appears only in prose. Both reasons have been in the output
  //   since, and this list still named the pre-R503 vocabulary, so the assertion reported "an undeclared reason" for a
  //   reason that was declared three rounds before this test was last edited.
  //
  //   `listed-not-registered` and `guarded-import` stay in the list: they are legitimate categories that simply have no
  //   members right now, and dropping them would hide a future regression that put something back into one.
  const reasons = new Set(['not-in-build', 'renamed', 'listed-not-registered', 'feature-gated',
    'flag-gated', 'guarded-import', 'requires-mcp-server', 'template-only-name']);
  for (const row of d.rows) {
    assert.ok(reasons.has(row.reason), `${row.contractName} has an undeclared reason: ${row.reason}`);
  }
  // Contract tools minus registered equals the rows explained. Nothing silently dropped.
  const accounted = d.runtimeCount + d.rows.length;
  assert.ok(accounted >= d.contractCount,
    `runtime ${d.runtimeCount} + explained ${d.rows.length} < contract ${d.contractCount}: `
    + 'some contract tools are neither registered nor explained');
});

test('the groups under the default flag set are counted correctly', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);
  const counts = d.rows.reduce((a, x) => { a[x.reason] = (a[x.reason] || 0) + 1; return a; }, {});
  assert.equal(counts['not-in-build'], 9, 'the not-in-build count changed: ' + JSON.stringify(counts));
  assert.equal(counts.renamed, 5, 'the renamed count changed');
  assert.equal(counts['feature-gated'], 2, 'the feature-gated count changed');
  // R503 MOVED THE WHOLE GROUP, AND THE OLD ASSERTION MESSAGE WAS THE CLUE
  //   The expectation was `listed-not-registered: 7` with the message "the unexplained count changed" — a label that
  //   was already wrong, because the category had become explicit rather than residual. R503 then moved its three
  //   remaining rows into `requires-mcp-server`, since a tool installed by an MCP server is not "listed but
  //   unregistered". The group is now EMPTY, and asserting 0 is the honest form: every one of the 44 contract tools
  //   has a reason, which is what R503 set out to achieve.
  assert.equal(counts['listed-not-registered'], undefined,
    'listed-not-registered has members again: something reverted to the pre-R503 classification');
  assert.equal(counts['requires-mcp-server'], 2, 'the requires-mcp-server count changed');
  assert.equal(counts['template-only-name'], 1, 'the template-only-name count changed');
  assert.equal(counts['flag-gated'], 4, 'the flag-gated count changed');
  // The whole point: no contract tool is left without an explanation.
  assert.equal(d.unexplainedCount, d.rows.length,
    'unexplainedCount no longer equals the explained rows');

  // The nine genuinely outside this build.
  const absent = d.rows.filter((r) => r.reason === 'not-in-build').map((r) => r.contractName).sort();
  assert.deepEqual(absent, ['ClaudeDesign', 'OfferChromeSetup', 'Projects', 'ProposeSkills',
    'ReadMcpResourceDir', 'ReadNotifications', 'ReportFindings', 'ScheduleWakeup',
    'ShowOnboardingRolePicker'], 'the not-in-build set changed');
});

test('the feature gates are named, not guessed', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);
  const byName = new Map(d.rows.map((r) => [r.contractName, r]));
  assert.match(byName.get('PushNotification').detail, /KAIROS/,
    'the PushNotification gate is no longer KAIROS');
  assert.match(byName.get('RemoteTrigger').detail, /AGENT_TRIGGERS_REMOTE/,
    'the RemoteTrigger gate is no longer AGENT_TRIGGERS_REMOTE');
});

test('a rename is only claimed when the runtime has the target name', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);
  const renames = new Map(d.rows.filter((r) => r.reason === 'renamed')
    .map((r) => [r.contractName, r.registeredName]));

  assert.equal(renames.get('Agent'), 'Task',
    'Agent no longer maps to Task: AgentTool declares thirteen names, so an inferred rule picks wrong');
  assert.equal(renames.get('FileRead'), 'Read');
  assert.equal(renames.get('FileEdit'), 'Edit');
  assert.equal(renames.get('FileWrite'), 'Write');
  assert.equal(renames.get('Artifact'), 'artifact');

  // AgentTool really does declare many names — that is why inference failed twice. Scan RECURSIVELY: a
  // top-level-only read finds two names, because the rest live in subdirectories.
  const agentDir = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'AgentTool');
  if (fs.existsSync(agentDir)) {
    const names = new Set();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(/TOOL_NAME\s*=\s*['"]([^'"]+)['"]/g)) names.add(m[1]);
      }
    };
    walk(agentDir);
    assert.ok(names.size >= 5,
      `AgentTool declares only ${names.size} names: the evidence-based rename may no longer be needed`);
    assert.ok(names.has('Task'), 'AgentTool no longer declares Task: the rename premise changed');
  }
});

test('the unexplained category is empty, and would be labelled if it were not', { skip: !haveAll }, () => {
  const d = JSON.parse(run().stdout);
  const unexplained = d.rows.filter((r) => r.reason === 'listed-not-registered');
  // THIS TEST USED TO REQUIRE THE GROUP TO BE NON-EMPTY, AND R503 EMPTIED IT
  //   The original assertion was `unexplained.length > 0` — R500 had genuine residue and the test checked that residue
  //   was labelled rather than given a mechanism. R503 then explained all three remaining rows (`requires-mcp-server`),
  //   which was the goal. Keeping "must be non-empty" would require the tool to be WORSE than it is.
  //
  //   What still has to hold is the labelling rule on any row that does land in the category. Asserting the empty state
  //   explicitly means a future regression that reintroduces residue is visible, and the rule below still guards how it
  //   would be described.
  assert.equal(unexplained.length, 0,
    'residue is back in listed-not-registered: either a new gap appeared or R503\'s explanations were undone');
  for (const row of unexplained) {
    assert.match(row.detail, /unexplained/,
      `${row.contractName} is given a detail that does not admit it is unexplained`);
  }
});

test('the flag set is explicit, not inherited from a previous run', { skip: !haveAll }, () => {
  // The second mistake: reading the cache file gave whichever flag set ran last, so TodoWrite vanished from the
  // default surface after a --tasks run.
  const base = JSON.parse(run().stdout);
  assert.equal(base.flagSet, 'default', 'the default run does not report its flag set');
  assert.equal(base.runtimeCount, 39, 'the default runtime count changed');

  const withTasks = JSON.parse(run(['--tasks']).stdout);
  assert.equal(withTasks.flagSet, 'tasks', 'the --tasks run does not report its flag set');
  assert.equal(withTasks.runtimeCount, 42, 'the --tasks runtime count changed');
  assert.notEqual(base.rows.length, withTasks.rows.length,
    'both flag sets explain the same number of absences: the baseline is being inherited');

  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /runtimeRegistered\(flagSet\)/, 'the flag set is no longer passed to the probe');
});

test('the tool states it evaluates no flag', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /does not evaluate any flag|evaluates no flag/i,
    'the tool no longer disclaims evaluation');
});
