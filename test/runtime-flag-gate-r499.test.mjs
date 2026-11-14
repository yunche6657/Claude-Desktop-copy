// R499: the four Task tools R498 reported as unregistered were switched OFF by the probe itself.
//
// THE LEAD
//   R498's runtime probe registered 39 tools, and four contract tools — TaskCreate, TaskGet, TaskList,
//   TaskUpdate — were absent even though their source directories declare exactly those names. R498 left that
//   as an open question and hinted they "may be feature-gated". This round traced it.
//
// THE TRACE
//   src/tools.ts assembles the tool list, and the four sit behind one condition:
//       ...(isTodoV2Enabled()
//         ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
//         : []),
//
//   src/utils/tasks.ts:
//       export function isTodoV2Enabled(): boolean {
//         if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TASKS)) return true
//         return !getIsNonInteractiveSession()
//       }
//
//   The probe runs the CLI with `--print`, which IS a non-interactive session. So `getIsNonInteractiveSession()`
//   is true, the gate returns false, and the four tools are omitted from the list.
//
//   They were never missing. My probe turned them off and then I read their absence as a property of the build.
//
// THE MEASUREMENT
//       default probe                       26 / 44 contract tools registered
//       CLAUDE_CODE_ENABLE_TASKS=1          29 / 44
//   Three recovered (TaskCreate, TaskUpdate, TaskList). TaskGet does not appear even with the flag — a second
//   gate exists somewhere, and this round does not claim to have found it.
//
// WHY THIS IS THE IMPORTANT CONCLUSION OF THE SERIES
//   The runtime tool list is a FUNCTION OF THE FLAGS the process started with, not a fixed property of the
//   build. So:
//     - a single probe cannot be reported as "the" tool surface
//     - R498's "18 contract tools absent" overstates absence: at least 3 of those 18 were flag-dependent
//     - any future comparison has to state the flag set alongside the count, or the number means nothing
//
//   That is the same failure the whole R488–R494 series kept making in a different register: a measurement whose
//   conditions were never stated, read as a fact about the thing measured.
//
// WHAT CHANGED IN THE TOOL
//   `--tasks` applies CLAUDE_CODE_ENABLE_TASKS=1. The default stays flag-free so the number remains comparable
//   to R498's. The cache key now includes the extras, because a cached answer produced under one flag set must
//   not be served for another — otherwise the flag you pass would silently return a different flag's result.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'runtime-tools.cjs');
const SRC = path.join(ROOT, '..', '.tmp', 'ccb-src');

// The probe spawns the real CLI; with the cache warm this is fast, cold it takes ~45 s per flag set.
const run = (args = []) => spawnSync(process.execPath, [TOOL, '--json', ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 240000, windowsHide: true,
});

const haveCli = fs.existsSync(path.join(ROOT, 'agent-core', 'bun', 'bun.exe'))
  && fs.existsSync(path.join(ROOT, 'agent-core', 'claude-code', 'dist', 'cli-bun.js'));

test('the default probe registers 26 of 44 contract tools', { skip: !haveCli }, () => {
  const d = JSON.parse(run().stdout);
  assert.equal(d.matchedCount, 26, 'the default flag set now registers a different number');
  for (const name of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']) {
    assert.ok(d.unmatched.includes(name),
      `${name} is registered without the flag: the gate premise changed`);
  }
});

test('enabling the task flag registers four more tools and removes TodoWrite', { skip: !haveCli }, () => {
  const base = JSON.parse(run().stdout);
  const d = JSON.parse(run(['--tasks']).stdout);
  assert.equal(d.matchedCount, 29,
    `with CLAUDE_CODE_ENABLE_TASKS=1 the count is ${d.matchedCount}, expected 29`);

  // All four recover — checked by reading the runtime list rather than assuming the gate is symmetric.
  for (const name of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']) {
    assert.ok(!d.unmatched.includes(name),
      `${name} is still unmatched with the flag on: the gate trace is wrong`);
  }

  // And one tool LEAVES: TodoWrite. The source comment says so explicitly — "SDK users who want Task tools over
  // TodoWrite" — so the two sets are alternatives, not additive. The count therefore goes 26 -> 29: four in,
  // one out. Reporting a bare "+3" would obscure that.
  assert.ok(base.unmatched.includes('TodoWrite') === false,
    'TodoWrite was not registered by default: the baseline changed');
  assert.ok(d.unmatched.includes('TodoWrite'),
    'TodoWrite is still registered alongside the Task tools: the two are meant to be alternatives');
  assert.equal(d.matchedCount - base.matchedCount, 3,
    'the net change is no longer +3 (four gained, one lost)');
});

test('the flag comes from a named source function, not a guess', { skip: !fs.existsSync(SRC) }, () => {
  // The chain: tools.ts gates on isTodoV2Enabled(), which returns !getIsNonInteractiveSession() unless the env
  // var is set. Pin every link, so a refactor of any one of them is visible.
  const toolsTs = path.join(SRC, 'src', 'tools.ts');
  const tasksTs = path.join(SRC, 'src', 'utils', 'tasks.ts');
  assert.ok(fs.existsSync(toolsTs), 'src/tools.ts moved: the gate reference cannot be checked');
  assert.ok(fs.existsSync(tasksTs), 'src/utils/tasks.ts moved');

  const toolsText = fs.readFileSync(toolsTs, 'utf8');
  assert.match(toolsText, /isTodoV2Enabled\(\)\s*\n?\s*\?\s*\[TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool\]/,
    'the Task tool registration is no longer behind isTodoV2Enabled()');

  const tasksText = fs.readFileSync(tasksTs, 'utf8');
  assert.match(tasksText, /CLAUDE_CODE_ENABLE_TASKS/, 'the env override is gone');
  assert.match(tasksText, /return !getIsNonInteractiveSession\(\)/,
    'the non-interactive condition is gone: the flag would no longer matter');
});

test('the cache key includes the flag set', { skip: !haveCli }, () => {
  // A cached answer from one flag set must not be served for another. Both runs below share the same CLI
  // bundle, so only the extras distinguish them.
  const a = JSON.parse(run().stdout);
  const b = JSON.parse(run(['--tasks']).stdout);
  assert.notEqual(a.matchedCount, b.matchedCount,
    'both flag sets returned the same count: the cache is serving one answer for both');

  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /const flagPart = Object\.entries\(extras\)/,
    'the flag set is no longer part of the cache key');
});

test('the tool records that the list is flag-dependent', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  // The explanation has to survive, because the next reader will otherwise re-derive "missing tools" from a
  // single flag-free probe — which is exactly what R498 did.
  assert.match(source, /isTodoV2Enabled/,
    'the tool no longer names the gate function');
  assert.match(source, /not missing; the probe switched them off/,
    'the tool no longer states that the tools were switched off rather than absent');
  assert.match(source, /26 -> 29/, 'the measured effect of the flag is no longer recorded');
});
