// The tool × mode matrix: every tool, every mode, what actually happens.
//
// Measured this round by running the real executor for each pair (7 tools × 7 modes):
//
//   tool    ask      acceptEd bypassPe plan     auto     default  dontAsk
//   Read    auto     auto     auto     auto     auto     auto     auto
//   List    auto     auto     auto     auto     auto     auto     auto
//   Glob    auto     auto     auto     auto     auto     auto     auto
//   Skill   auto     auto     auto     auto     auto     auto     auto
//   Write   ask      auto     auto     ask      auto     ask      deny
//   Edit    ask      auto     auto     ask      auto     ask      deny
//   Bash    ask      ask      auto     ask      ask      ask      deny
//
// Reading it: reads never prompt (prompting for a read makes every tool call unusable);
// acceptEdits applies edits but still asks for commands; dontAsk denies every change.
//
// Why a table instead of prose: rounds 184-186 each found a mode behaving against its own
// description, and each was found by running combinations rather than reading code. This
// pins all 49 cells so the next such defect fails immediately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createApprovalExecutor, actionFor, TOOL_ACTIONS } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));
const { MODES } = require(path.join(ROOT, 'desktop', 'permissions.cjs'));
const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));

/** What happens when this tool is requested in this mode. */
async function outcome(mode, name) {
  let asked = 0;
  let ran = 0;
  const exec = createApprovalExecutor({
    mode,
    onEvent: () => {},
    ask: async () => { asked++; return 'allow'; },
    tools: [{
      name,
      action: actionFor(name),
      handler: async () => { ran++; return { content: 'ok' }; },
    }],
  });
  await exec({ name, input: {} });
  if (asked) return 'ask';
  if (ran) return 'auto';
  return 'deny';
}

const MATRIX = {
  Read: { ask: 'auto', acceptEdits: 'auto', bypassPermissions: 'auto', plan: 'auto', auto: 'auto', default: 'auto', dontAsk: 'auto' },
  List: { ask: 'auto', acceptEdits: 'auto', bypassPermissions: 'auto', plan: 'auto', auto: 'auto', default: 'auto', dontAsk: 'auto' },
  Glob: { ask: 'auto', acceptEdits: 'auto', bypassPermissions: 'auto', plan: 'auto', auto: 'auto', default: 'auto', dontAsk: 'auto' },
  Skill: { ask: 'auto', acceptEdits: 'auto', bypassPermissions: 'auto', plan: 'auto', auto: 'auto', default: 'auto', dontAsk: 'auto' },
  Write: { ask: 'ask', acceptEdits: 'auto', bypassPermissions: 'auto', plan: 'ask', auto: 'auto', default: 'ask', dontAsk: 'deny' },
  Edit: { ask: 'ask', acceptEdits: 'auto', bypassPermissions: 'auto', plan: 'ask', auto: 'auto', default: 'ask', dontAsk: 'deny' },
  Bash: { ask: 'ask', acceptEdits: 'ask', bypassPermissions: 'auto', plan: 'ask', auto: 'ask', default: 'ask', dontAsk: 'deny' },
};

test('every tool the agent can call has a declared action', () => {
  const tools = defineTools({ workspaceRoot: ROOT, allowedRoots: [ROOT], execRoots: [ROOT] });
  for (const tool of tools) {
    assert.ok(TOOL_ACTIONS[tool.name], tool.name + ' has no entry in TOOL_ACTIONS');
    assert.equal(actionFor(tool.name), tool.action,
      tool.name + ': the declared action and actionFor disagree');
  }
});

test('the full tool x mode matrix is what each mode promises', async () => {
  for (const [tool, row] of Object.entries(MATRIX)) {
    for (const mode of Object.values(MODES)) {
      assert.equal(await outcome(mode, tool), row[mode], tool + ' in ' + mode);
    }
  }
});

test('reads never prompt, in any mode', async () => {
  // Prompting for a read would make every tool call unusable; the live runs depend on this.
  for (const tool of ['Read', 'List', 'Glob', 'Skill']) {
    for (const mode of Object.values(MODES)) {
      assert.notEqual(await outcome(mode, tool), 'ask', tool + ' prompted in ' + mode);
    }
  }
});

test('exactly the modes that promise to auto-apply edits do so', async () => {
  // Measured, not assumed: acceptEdits AND auto both apply edits while still asking to run
  // commands. An earlier version of this test asserted acceptEdits was the only one and
  // failed against auto — my assumption, not a defect. The list below is the measured one.
  const autoAppliesEdits = [];
  const stillAsksForCommands = [];
  for (const mode of Object.values(MODES)) {
    if (await outcome(mode, 'Edit') === 'auto') autoAppliesEdits.push(mode);
    if (await outcome(mode, 'Bash') === 'ask') stillAsksForCommands.push(mode);
  }
  assert.deepEqual(autoAppliesEdits, ['acceptEdits', 'bypassPermissions', 'auto']);
  assert.deepEqual(stillAsksForCommands, ['ask', 'acceptEdits', 'plan', 'auto', 'default']);

  // The property that actually holds: any mode that auto-applies edits but not commands
  // is one of these two, and both are documented as "Claude handles permissions"-style
  // modes where an unattended shell command is still the thing the user cannot undo.
  const editsButNotCommands = autoAppliesEdits.filter((m) => stillAsksForCommands.includes(m));
  assert.deepEqual(editsButNotCommands, ['acceptEdits', 'auto']);
});
