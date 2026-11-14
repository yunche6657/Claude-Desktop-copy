// R393: the official-44 vs CCB-tool-table number must stay true.
//
// worklist §2's claim ("CCB completely lacks these 10") was previously only an assertion in a
// hand-written table. This pins it to the vendored bundle, so a future re-adopt of agent-core
// cannot silently invalidate the worklist.
//
// Two measurement bugs are encoded here as tests, because both produced wrong numbers when this
// was first computed:
//
//   1. Cron arrives as `var cronTools = [CronCreateTool, CronDeleteTool, CronListTool]` and the
//      table spreads it (`...cronTools`). Scanning only `XTool` identifiers inside the table body
//      reported all three as missing.
//   2. `Mcp` is a dynamic schema, so it is neither present nor absent and must be excluded from
//      both sides rather than counted as a gap.
//
// ProposeGoal / ProposeSkills are also pinned as SEMANTIC MISMATCHES rather than absences: CCB
// implements them as GoalTool and DiscoverSkillsTool, both of which ARE in the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'agent-core', 'claude-code', 'dist');

const OFFICIAL = [
  'Agent', 'Artifact', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList',
  'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'FileEdit', 'FileRead',
  'FileWrite', 'Glob', 'Grep', 'ListMcpResources', 'Monitor', 'NotebookEdit',
  'PushNotification', 'ReadMcpResource', 'ReadMcpResourceDir', 'RemoteTrigger', 'TaskCreate',
  'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'WebFetch', 'WebSearch',
  'ReadNotifications', 'ShowOnboardingRolePicker', 'RefreshMcpTools', 'OfferChromeSetup',
  'ReportFindings', 'ClaudeDesign', 'ScheduleWakeup', 'SendFeedback', 'Projects',
  'ProposeGoal', 'ProposeSkills', 'Workflow',
];
const DYNAMIC = ['Mcp'];

const SPELLINGS = {
  FileEdit: ['FileEditTool'], FileRead: ['FileReadTool'], FileWrite: ['FileWriteTool'],
  ListMcpResources: ['ListMcpResourcesTool'], ReadMcpResource: ['ReadMcpResourceTool'],
  AskUserQuestion: ['AskUserQuestionTool'], EnterPlanMode: ['EnterPlanModeTool'],
  ExitPlanMode: ['ExitPlanModeV2Tool', 'ExitPlanModeTool'], EnterWorktree: ['EnterWorktreeTool'],
  ExitWorktree: ['ExitWorktreeTool'], TodoWrite: ['TodoWriteTool'], WebFetch: ['WebFetchTool'],
  WebSearch: ['WebSearchTool'], NotebookEdit: ['NotebookEditTool'],
  PushNotification: ['PushNotificationTool'], RemoteTrigger: ['RemoteTriggerTool'],
  TaskCreate: ['TaskCreateTool'], TaskGet: ['TaskGetTool'], TaskList: ['TaskListTool'],
  TaskStop: ['TaskStopTool'], TaskUpdate: ['TaskUpdateTool'],
  CronCreate: ['CronCreateTool'], CronDelete: ['CronDeleteTool'], CronList: ['CronListTool'],
  Glob: ['GlobTool'], Grep: ['GrepTool'], Bash: ['BashTool'], Agent: ['AgentTool'],
  Artifact: ['ArtifactTool'], Monitor: ['MonitorTool'], Workflow: ['WorkflowTool'],
};

/** The tool table's source, plus every identifier reachable through a spread it performs. */
function table() {
  for (const name of fs.readdirSync(DIST)) {
    if (!name.endsWith('.js')) continue;
    const p = path.join(DIST, name);
    if (fs.statSync(p).size > 20_000_000) continue;
    const src = fs.readFileSync(p, 'utf8');
    const at = src.indexOf('function getAllBaseTools()');
    if (at < 0) continue;
    const body = src.slice(at, src.indexOf('\n}', at));
    const spreadIds = new Set();
    for (const m of body.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
      const name2 = m[1];
      const defAt = src.indexOf('var ' + name2 + ' = [');
      if (defAt < 0) continue;
      const def = src.slice(defAt, src.indexOf('];', defAt));
      for (const id of def.matchAll(/\.([A-Za-z_$][\w$]*)/g)) spreadIds.add(id[1]);
    }
    return { file: name, src, body, spreadIds };
  }
  throw new Error('getAllBaseTools() is gone from the vendored kernel');
}

function has(tbl, tool) {
  const spellings = SPELLINGS[tool] || [tool + 'Tool'];
  return spellings.some((s) => tbl.body.includes(s) || tbl.spreadIds.has(s));
}

test('the tool table is still findable and still spreads cronTools', () => {
  // If a re-adopt restructures the table, every count below becomes meaningless — fail here
  // first, with a message that says what to redo.
  const tbl = table();
  assert.ok(tbl.body.length > 100, 'the tool table body is suspiciously small');
  assert.ok(tbl.body.includes('...cronTools'),
    'cronTools is no longer spread into the table: recheck the Cron rows of the comparison');
  assert.ok(tbl.spreadIds.has('CronCreateTool'),
    'the cronTools spread could not be resolved: the Cron rows would be falsely "missing"');
});

test('exactly 34 of the 42 comparable official tools are present', () => {
  // 31 -> 32 in R400 (ProposeGoal), 32 -> 33 in R403 (RefreshMcpTools), 33 -> 34 in R412
  // (SendFeedback). The count is a live measurement of the bundle and must be re-derived
  // whenever a tool is added.
  const tbl = table();
  const present = OFFICIAL.filter((t) => !DYNAMIC.includes(t) && has(tbl, t));
  assert.equal(present.length, 34,
    'the present count changed; evidence/changelog-crosscheck-5.2.md needs a new number.\nPresent: '
      + present.join(', '));
  for (const added of ['ProposeGoal', 'RefreshMcpTools', 'SendFeedback']) {
    assert.ok(present.includes(added), added + ' is no longer present: an addition was lost');
  }
});

test('nine official names are absent, one of which is implemented under another name', () => {
  // HISTORY
  //   R393: 12 absent-by-name (10 real + ProposeGoal + ProposeSkills labelled mismatches).
  //   R400: ProposeGoal implemented -> 11.
  //   R403: RefreshMcpTools implemented -> 10.
  //   R412: SendFeedback implemented -> 9.
  //   ProposeSkills stays absent-by-name: DiscoverSkillsTool SEARCHES skills, it does not WRITE
  //   them, and CCB has no review-card UI to surface proposals.
  const tbl = table();
  const missing = OFFICIAL.filter((t) => !DYNAMIC.includes(t) && !has(tbl, t));
  assert.deepEqual(missing.sort(), [
    'ClaudeDesign', 'OfferChromeSetup', 'Projects', 'ProposeSkills',
    'ReadMcpResourceDir', 'ReadNotifications', 'ReportFindings',
    'ScheduleWakeup', 'ShowOnboardingRolePicker',
  ], 'the absent-by-name set changed; worklist §2/§3 no longer match the bundle');

  const semanticMismatch = ['ProposeSkills'];
  const trulyAbsent = missing.filter((t) => !semanticMismatch.includes(t));
  assert.equal(trulyAbsent.length, 8,
    'the genuinely-absent count changed.\nGot: ' + trulyAbsent.join(', '));
  assert.deepEqual(trulyAbsent.sort(), [
    'ClaudeDesign', 'OfferChromeSetup', 'Projects', 'ReadMcpResourceDir',
    'ReadNotifications', 'ReportFindings', 'ScheduleWakeup', 'ShowOnboardingRolePicker',
  ]);
});


test('ProposeSkills is still a mismatch; ProposeGoal is now a real implementation', () => {
  // R393 grouped both under "semantic mismatch". R400 showed that grouping was wrong for one of
  // them:
  //
  //   ProposeGoal  -> CCB had GoalTool, which only READS and TERMINATES an existing goal. The
  //                   official tool CREATES one. That is a missing capability, not a renamed one,
  //                   so R400 added ProposeGoalTool. It is present by name now.
  //   ProposeSkills-> DiscoverSkillsTool SEARCHES skills; the official tool WRITES them
  //                   (`proposals[]` with full `skillMd`). Still a mismatch, still absent by name.
  const tbl = table();
  assert.ok(has(tbl, 'ProposeGoal'),
    'ProposeGoal vanished from the table: the R400 addition was lost');
  assert.ok(!has(tbl, 'ProposeSkills'),
    'ProposeSkills now exists by name: move it out of §3 and update the worklist');
  assert.ok(tbl.body.includes('DiscoverSkillsTool'),
    'DiscoverSkillsTool is gone, so ProposeSkills is a plain absence after all');
});

test('ProposeGoal was added alongside GoalTool, not instead of it', () => {
  // The load-bearing decision of R400. Rewriting GoalTool would have stranded every existing
  // goal; the two tools cover different halves of the same lifecycle.
  const tbl = table();
  assert.ok(tbl.body.includes('GoalTool'),
    'GoalTool was removed: existing goals can no longer be inspected or closed');
  assert.ok(tbl.body.includes('ProposeGoalTool'),
    'ProposeGoalTool is not registered in the tool table, so the model cannot see it');
});

test('Mcp is excluded on both sides rather than counted as a gap', () => {
  // It is a dynamic schema (worklist §4). Counting it as missing inflates the gap by one;
  // counting it as present would claim a static match that does not exist.
  assert.ok(DYNAMIC.includes('Mcp'));
  assert.ok(!OFFICIAL.includes('Mcp'), 'Mcp is in the comparable list and would be mis-scored');
});
