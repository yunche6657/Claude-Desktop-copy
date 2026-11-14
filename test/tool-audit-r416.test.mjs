// R416: the tool-coverage audit, done against RUNTIME names with a blind-spot gate.
//
// WHY THIS FILE EXISTS AT ALL
//   Five successive audit methods produced five confident, wrong counts. Each defect is now an
//   assertion here, because the failure modes are more instructive than the number:
//
//     1. interface name vs runtime name    -> 'Artifact' vs 'artifact'
//     2. spread-placed tools               -> `...cronTools`, `...(X ? [X] : [])`
//     3. array truncated at the first "\n}" -> hid the three tools added in R400/R403/R412
//     4. assumed *_TOOL_NAME must be exported -> 12 of them are not
//     5. mapping table filled with SYMBOL names instead of runtime names
//
//   The gate that stops a sixth: before any count is produced, the audit must be able to see
//   tools that are known to be registered. If it cannot, the audit is broken and must say so
//   rather than print a number.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const TOOLS_TS = path.join(SRC, 'src', 'tools.ts');
const TOOLS_ROOT = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');

/** The registration array, bracket-balanced. Never `indexOf('\n}')` — that truncates it. */
function registrationArray() {
  const text = fs.readFileSync(TOOLS_TS, 'utf8');
  const at = text.indexOf('function getAllBaseTools()');
  assert.ok(at > 0, 'getAllBaseTools is gone');
  const start = text.indexOf('[', at);
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, 'the registration array is not bracket-balanced');
  return text.slice(start, end + 1);
}

/** Runtime tool names, read from every tool module's name constant or literal. */
function runtimeNames() {
  const byDir = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      const t = fs.readFileSync(full, 'utf8');
      const dirName = path.basename(path.dirname(full));
      let found = [...t.matchAll(/const\s+\w*TOOL_NAME\w*\s*=\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1]);
      if (found.length === 0) {
        // Some tools skip the constant and pass a literal: ReadMcpResourceTool does.
        found = [...t.matchAll(/buildTool\(\s*\{[\s\S]{0,500}?\bname:\s*['"]([^'"]+)['"]/g)]
          .map((m) => m[1]);
      }
      if (found.length) {
        const set = byDir.get(dirName) ?? new Set();
        for (const n of found) set.add(n);
        byDir.set(dirName, set);
      }
    }
  };
  walk(TOOLS_ROOT);

  // Not every tool is declared inside packages/builtin-tools. `Workflow` gets its name from
  // @claude-code-best/workflow-engine, and src/constants/tools.ts pins the value in a comment:
  //     WORKFLOW_TOOL_NAME, // 'Workflow'
  // A directory-only resolver silently drops it — exactly how R416 undercounted.
  const constTools = path.join(SRC, 'src', 'constants', 'tools.ts');
  const external = new Set();
  for (const m of fs.readFileSync(constTools, 'utf8')
    .matchAll(/(\w+_TOOL_NAME),?\s*\/\/\s*'([^']+)'/g)) {
    external.add(m[2]);
  }
  if (external.size) byDir.set('__external__', external);

  return byDir;
}

function audit() {
  const table = registrationArray();
  const byDir = runtimeNames();

  // ---------------- SANITY GATE (see header note 3) ----------------
  const mustSee = ['ProposeGoalTool', 'RefreshMcpToolsTool', 'SendFeedbackTool', 'ArtifactTool'];
  const blind = mustSee.filter((s) => !table.includes(s));
  assert.deepEqual(blind, [],
    'the audit cannot see tools that are known to be registered: the array was truncated, so any '
    + 'count it produces is wrong. Fix the extraction before trusting the numbers below.');

  // ---------------- resolve symbols -> runtime names ----------------
  const text = fs.readFileSync(TOOLS_TS, 'utf8');
  const symbols = new Set(table.match(/\b[A-Za-z_$][\w$]*Tool2?\b/g) ?? []);
  for (const m of table.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    const decl = new RegExp(
      '(?:const|let|var)\\s+' + m[1] + '\\s*=\\s*\\[([\\s\\S]*?)\\]',
    ).exec(text);
    if (decl) for (const s of decl[1].match(/\b[A-Za-z_$][\w$]*Tool2?\b/g) ?? []) symbols.add(s);
  }

  const registered = new Set();
  for (const sym of symbols) {
    const base = sym.replace(/^get/, '').replace(/2$/, '');
    for (const cand of [base, base + 'Tool']) {
      if (byDir.has(cand)) {
        for (const n of byDir.get(cand)) registered.add(n);
        break;
      }
    }
    // Symbol -> directory lookup is not enough. `ExitPlanModeV2Tool` strips to
    // `ExitPlanMode`, but its directory is `ExitPlanModeTool` AND the constant inside is
    // `EXIT_PLAN_MODE_V2_TOOL_NAME` — neither of which a name-based lookup reaches. Resolve by
    // VALUE instead: does any directory declare this symbol's name as a runtime name?
    const lower = base.toLowerCase();
    for (const [dirName, names] of byDir) {
      if (dirName.toLowerCase().replace(/tool$/, '') === lower
          || [...names].some((n) => n.toLowerCase() === lower)) {
        for (const n of names) registered.add(n);
      }
    }
  }
  return registered;
}

test('the audit can see its own known-present tools', () => {
  // If this fails, every other assertion in this file is meaningless. That is the point: three
  // earlier audits reported "your additions are missing" because they were blind, not because
  // the additions were absent.
  const table = registrationArray();
  for (const sym of ['ProposeGoalTool', 'RefreshMcpToolsTool', 'SendFeedbackTool', 'ArtifactTool']) {
    assert.ok(table.includes(sym), 'audit is blind to ' + sym + ': fix extraction, do not report');
  }
});

test('Artifact is present under the lowercase runtime name', () => {
  // The defect that started this round: the interface is `Artifact`, the tool name is 'artifact'.
  // A name-only comparison reported it absent for thirteen rounds.
  const names = audit();
  assert.ok(names.has('artifact'),
    'the lowercase artifact tool name disappeared: re-derive §3.4');
  assert.ok(!names.has('Artifact'),
    'a capitalized Artifact tool appeared: the CCB tool may have been rewritten');
});

test('Artifact is NOT the official tool, despite the name', () => {
  // Same name, different capability. Recorded so nobody reads "artifact is present" as
  // "§3.4 is done".
  const src = fs.readFileSync(
    path.join(TOOLS_ROOT, 'ArtifactTool', 'ArtifactTool.ts'), 'utf8',
  );
  assert.match(src, /z\.strictObject\(\{/,
    'ArtifactTool no longer uses a strict object schema: re-derive its field set');
  for (const field of ['file_path', 'hash', 'ttl']) {
    assert.ok(src.includes(field + ':'), 'ArtifactTool lost ' + field);
  }
  // The official action set must NOT be here — if it appears, §3.4 became implementable.
  for (const action of ['upload_asset', 'list_assets', 'delete_asset', 'list_types']) {
    assert.ok(!src.includes(action),
      'ArtifactTool gained ' + action + ': §3.4 may now be implementable, revisit');
  }
  // And the TTL is the clearest capability marker: 7/30-day expiry vs permanent artifacts.
  // Single-line match on purpose — these sources are CRLF, and a multi-line pattern written with
  // bare \n cannot span them. That mistake has cost time in five separate rounds.
  assert.ok(src.includes('.union([z.literal(7), z.literal(30)])'),
    'ArtifactTool no longer takes a 7/30-day TTL: its lifetime model changed');
});

test('the five audit failure modes each stay fixed', () => {
  const table = registrationArray();
  const names = audit();

  // Mode 2 + 3: spread-placed tools are seen, and the array is not truncated.
  assert.ok(table.includes('...cronTools'), 'cronTools spread is gone; re-derive mode 2');
  for (const cron of ['CronCreate', 'CronDelete', 'CronList']) {
    assert.ok(names.has(cron), 'spread-placed tool not resolved: ' + cron);
  }

  // Mode 4: name constants that are NOT exported must still be read.
  const goalName = fs.readFileSync(
    path.join(TOOLS_ROOT, 'ProposeGoalTool', 'ProposeGoalTool.ts'), 'utf8',
  );
  assert.match(goalName, /^const PROPOSE_GOAL_TOOL_NAME = 'ProposeGoal'/m,
    'ProposeGoal name constant changed shape; mode 4 may regress');
  assert.ok(names.has('ProposeGoal'),
    'a non-exported name constant was not picked up: mode 4 regressed');

  // Mode 5: runtime names, never symbol names.
  assert.ok(!names.has('ProposeGoalTool'),
    'the audit is reporting symbol names as runtime names: mode 5 regressed');
  assert.ok(names.has('Monitor') && !names.has('MonitorTool'),
    'Monitor should resolve to the bare runtime name');
});

test('the corrected count is 34 present out of 44 official interfaces', () => {
  const names = audit();
  const dts = fs.readFileSync(DTS, 'utf8');
  const official = [...new Set(
    [...dts.matchAll(/export interface ([A-Za-z0-9]+)Input\b/g)].map((m) => m[1]),
  )].sort();

  // Runtime names that differ from the interface name, each justified by a tool directory.
  const DIFFERENT = {
    Artifact: 'artifact',                      // ArtifactTool/prompt.ts
    FileEdit: 'Edit',                          // FileEditTool/constants.ts
    FileRead: 'Read',                          // FileReadTool/prompt.ts
    FileWrite: 'Write',                        // FileWriteTool/prompt.ts
    ListMcpResources: 'ListMcpResourcesTool',  // const
    ReadMcpResource: 'ReadMcpResourceTool',    // literal in buildTool, not a constant
    ExitPlanMode: 'ExitPlanMode',              // constants.ts EXIT_PLAN_MODE_V2_TOOL_NAME
    Workflow: 'Workflow',                      // workflow-engine WORKFLOW_TOOL_NAME
  };

  const present = official.filter((o) => names.has(DIFFERENT[o] ?? o));
  assert.equal(official.length, 44, 'the official interface count changed');
  // 31 in R416, corrected to 34 in R417 after resolving the three uncertain cases. The names
  // WORKFLOW_TOOL_NAME and the ExitPlanMode constants live outside packages/builtin-tools, so a
  // directory-only resolver misses them; ReadMcpResourceTool uses a literal, not a constant.
  assert.equal(present.length, 34,
    'the present count changed. Present: ' + present.join(', '));
  for (const resolved of ['ExitPlanMode', 'ReadMcpResource', 'Workflow']) {
    assert.ok(present.includes(resolved),
      resolved + ' was resolved in R417; it must stay present');
  }

  // The three additions from this session must be inside that set.
  for (const added of ['ProposeGoal', 'RefreshMcpTools', 'SendFeedback']) {
    assert.ok(present.includes(added), added + ' is not counted as present');
  }
});
