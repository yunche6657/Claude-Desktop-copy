// R408: effort has THREE sources in CCB, and the official contract specifies precedence for only
// one of them (`model`), not for `effort`.
//
// WHY THIS IS A VERDICT, NOT A FIX
//   R407's handoff flagged "spawnTeammate's effort semantics" as the next boundary, implying it
//   might need a fix. Investigating showed the situation is different from what R406 assumed:
//
//     1. agent-definition frontmatter   runAgent.ts:491  (pre-existing)
//     2. skill / slash command          SkillTool.ts:210 (pre-existing)
//     3. per-call Agent({ effort })     query.ts:935     (added in R406)
//
//   Sources 1 and 2 mean a TEAMMATE ALREADY gets effort, via its agent definition. What is
//   missing is only the per-call override reaching teammates. Extending that would require
//   touching four places and would pin down a precedence rule the official contract never
//   states — while `model`'s doc DOES state its precedence explicitly. That asymmetry is the
//   finding: inventing a rule to look complete is worse than recording the gap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

test('the official contract states model precedence but NOT effort precedence', () => {
  // The asymmetry this whole round turns on. If `effort` ever gains a precedence sentence, the
  // R406 implementation choice can be checked against it instead of guessed.
  const dts = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
  assert.ok(fs.existsSync(dts), 'the official sdk-tools.d.ts is missing');
  const text = fs.readFileSync(dts, 'utf8');

  // model: precedence IS spelled out.
  assert.match(text, /Optional model override for this agent\. Takes precedence over the agent definition's model frontmatter/,
    'the model precedence sentence changed or vanished: re-derive the asymmetry');

  // effort: no precedence statement anywhere in its doc block.
  // The window is bounded by the NEXT field declaration (`effort?:`), not by a fixed length:
  // a fixed 700-char slice spilled into `run_in_background`'s doc block. The conclusion happened
  // to survive (that block has no "takes precedence" either), but a window that reads the wrong
  // field cannot be trusted to detect the thing it is checking.
  const effortDocAt = text.indexOf('Reasoning effort for this agent.');
  assert.ok(effortDocAt > 0, 'the effort doc block moved');
  const fieldAt = text.indexOf('effort?:', effortDocAt);
  assert.ok(fieldAt > effortDocAt, 'the effort field declaration is not after its doc block');
  const docBlock = text.slice(effortDocAt, fieldAt);
  assert.ok(docBlock.length < 700,
    'the captured effort doc block is unexpectedly long: it may be swallowing a neighbouring field');
  assert.ok(!/takes precedence/i.test(docBlock),
    'effort now states a precedence rule: check whether R406\'s per-call-over-frontmatter choice '
    + 'still matches it, and update evidence/effort-precedence-r408.md');
});

test('CCB has all three effort sources, and they are the ones this round claims', () => {
  // Source 1: agent-definition frontmatter, applied inside runAgent's getAppState wrapper.
  const runAgent = read('packages', 'builtin-tools', 'src', 'tools', 'AgentTool', 'runAgent.ts');
  assert.match(runAgent, /agentDefinition\.effort !== undefined\s*\r?\n\s*\?\s*agentDefinition\.effort\s*\r?\n\s*:\s*state\.effortValue/,
    'the agent-definition effort source is gone: re-derive how agents get effort');

  // Source 2: skill / slash command merges its own effort into the agent definition.
  const skill = read('packages', 'builtin-tools', 'src', 'tools', 'SkillTool', 'SkillTool.ts');
  assert.match(skill, /command\.effort !== undefined\s*\r?\n\s*\?\s*\{ \.\.\.baseAgent, effort: command\.effort \}/,
    'the skill effort source is gone');

  // Source 3: the per-call path added in R406.
  const query = read('src', 'query.ts');
  assert.match(query, /getSubagentEffortOverride\(\) \?\? appState\.effortValue/,
    'the per-call effort source is gone');
});

test('a teammate already receives effort through its agent definition', () => {
  // This is what makes "teammates have no effort" WRONG, and it is why no fix was made.
  const inProcess = read('src', 'utils', 'swarm', 'inProcessRunner.ts');
  assert.match(inProcess, /import \{ runAgent \} from '@claude-code-best\/builtin-tools\/tools\/AgentTool\/runAgent\.js'/,
    'the teammate runner no longer goes through runAgent, so this conclusion needs redoing');
  assert.match(inProcess, /agentDefinition,/, 'agentDefinition is no longer passed into the runner');

  // The runner builds a TEAMMATE context, not a subagent one.
  assert.match(inProcess, /agentType: 'teammate'/, 'the teammate context type changed');
});

test('the per-call override deliberately does NOT reach teammates', () => {
  // Recorded so the absence is a decision, not an oversight someone "fixes" by accident.
  const ctx = read('src', 'utils', 'agentContext.ts');
  assert.match(ctx, /return context\?\.agentType === 'subagent'/,
    'isSubagentContext changed: re-derive whether teammates now get the per-call override');
  assert.match(ctx, /return isSubagentContext\(ctx\) \? ctx\.effortOverride : undefined/,
    'the reader no longer restricts to subagents');

  // And none of the teammate plumbing carries an effort field.
  const spawn = read('packages', 'builtin-tools', 'src', 'tools', 'shared', 'spawnMultiAgent.ts');
  assert.ok(!/effort/.test(spawn),
    'spawnMultiAgent gained effort: the per-call path may now reach teammates, revisit §4');

  const types = read('src', 'utils', 'swarm', 'backends', 'types.ts');
  const cfgAt = types.indexOf('export type TeammateSpawnConfig');
  assert.ok(cfgAt > 0, 'TeammateSpawnConfig is gone');
  const cfg = types.slice(cfgAt, cfgAt + 1400);
  assert.ok(!/effort/.test(cfg),
    'TeammateSpawnConfig gained effort: revisit whether this was decided or slipped in');
});

test('model and effort differ in what they say about fork, but both are handled', () => {
  // R407 established that a fork ignores effort. The model doc says the same about model.
  // This asserts the parallelism that justified R407's fix shape still holds.
  const dts = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
  const text = fs.readFileSync(dts, 'utf8');
  assert.match(text, /Ignored for subagent_type: "fork": a fork runs at your own effort\./,
    'the fork/effort rule changed: re-derive R407');

  const agent = read('packages', 'builtin-tools', 'src', 'tools', 'AgentTool', 'AgentTool.tsx');
  assert.match(agent, /!isForkPath && effort/, 'the R407 fork guard is gone');
  assert.match(agent, /model: isForkPath \? undefined : model/,
    'the model/fork precedent is gone, which undermines the effort guard shape');
});
