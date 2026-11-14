// R400: ProposeGoal added to CCB — worklist §3.1 reclassified from "rewrite" to "add".
//
// THE FINDING THAT CHANGED THE PLAN
//   worklist §3.1 called ProposeGoal a "semantic mismatch" implemented by `GoalTool`, and
//   prescribed a rewrite. Reading the source showed that is wrong:
//
//     GoalTool       action: "get"|"update", status: "complete"|"blocked", reason
//                    -> reads and TERMINATES an existing goal. Cannot create one.
//     setGoal()      exactly ONE non-test call site: src/commands/goal/goal.tsx:75, the /goal
//                    slash command. So the model could never create a goal; only the user could.
//     ProposeGoal    condition + ask_user -> CREATES a goal subject to approval.
//
//   So the capability was MISSING, not renamed. Rewriting GoalTool would have stranded every
//   existing goal, so the correct action was to add ProposeGoalTool alongside it.
//
// These assertions pin both the new tool's contract and the coexistence decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST, findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_TOOL = path.resolve(
  ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'tools',
  'ProposeGoalTool', 'ProposeGoalTool.ts',
);
const SRC_TOOLS_TS = path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'src', 'tools.ts');

/** The tool table body from the vendored bundle. */
function tableBody() {
  const { body } = (() => {
    const { text } = findChunk('function getAllBaseTools()');
    const at = text.indexOf('function getAllBaseTools()');
    return { body: text.slice(at, at + text.slice(at).indexOf('\n}')) };
  })();
  return body;
}

test('the bundle declares ProposeGoal with the official input fields', () => {
  const { text } = findChunk('ProposeGoalTool = buildTool(');
  // Descriptions are copied verbatim from sdk-tools.d.ts, so they are the most stable evidence
  // that these are the declared fields and not a paraphrase.
  assert.ok(text.includes('The completion condition to propose'),
    'the official `condition` description is absent');
  assert.ok(text.includes('Whether to ask the user for approval before the goal is set'),
    'the official `ask_user` description is absent');
  assert.ok(text.includes('"ProposeGoal"'),
    'the literal tool name is missing, so the model would not see it as ProposeGoal');
});

test('the official input/output naming split is preserved', () => {
  // sdk-tools.d.ts has `ask_user` on the INPUT and `askUser` on the OUTPUT. Getting this wrong
  // was a real type error while implementing; pin it so a refactor cannot quietly unify them.
  const src = fs.readFileSync(SRC_TOOL, 'utf8');
  assert.match(src, /ask_user:\s*z\s*\n?\s*\.boolean\(\)/,
    'the input field is no longer `ask_user`');

  // R423 replaced the plain output type with a zod schema, so the old `askUser: boolean` form is
  // gone. What must hold is the NAMING SPLIT, not a particular spelling of the output side:
  // `ask_user` (snake) on input, `askUser` (camel) on output.
  assert.match(src, /askUser:/,
    'the output field is no longer `askUser`');
  assert.match(src, /type\s+ProposeOutput\s*=\s*z\.infer<OutputSchema>/,
    'the output type is no longer derived from the schema');

  // The guard against unifying the two names. Scoped to the INPUT schema block, because the
  // output schema legitimately declares `askUser: z.boolean()`.
  const inputAt = src.indexOf('const inputSchema');
  const outputAt = src.indexOf('const outputSchema');
  assert.ok(inputAt > 0 && outputAt > inputAt,
    'the input/output schema blocks are not in the expected order');
  const inputBlock = src.slice(inputAt, outputAt);
  assert.ok(!/askUser:/.test(inputBlock),
    'an `askUser` input field appeared: the official input is snake_case');
});

test('ProposeGoal CREATES a goal, which GoalTool cannot', () => {
  // The whole reason the tool was added rather than a GoalTool rewrite performed.
  const src = fs.readFileSync(SRC_TOOL, 'utf8');
  assert.match(src, /setGoal\(condition\)/,
    'the tool no longer calls setGoal: it cannot create a goal');
  assert.match(src, /persistCurrentGoal\(\)/,
    'the goal is not persisted, so it would vanish with the process');
  assert.ok(!/completeGoal|clearGoal/.test(src),
    'the tool grew terminate/clear behaviour, which belongs to GoalTool');
});

test('ask_user defaults to true — an unapproved goal must not steer the session', () => {
  // Defaulting to false would let the model silently take the session over. The official doc
  // says "Defaults to true — an approval dialog is shown", and the code must mirror that.
  const src = fs.readFileSync(SRC_TOOL, 'utf8');
  assert.match(src, /input\.ask_user\s*!==\s*false/,
    'the default flipped: `ask_user` must be treated as true unless explicitly false');
  assert.ok(!/input\.ask_user\s*===\s*true/.test(src),
    'the code now requires an explicit true, which makes the default "no approval"');
});

test('GoalTool still exists in the table beside ProposeGoal', () => {
  const body = tableBody();
  assert.ok(body.includes('ProposeGoalTool'),
    'ProposeGoalTool is not registered: the model cannot reach it');
  assert.ok(body.includes('GoalTool'),
    'GoalTool was dropped: existing goals can no longer be inspected or closed');
  // Both are gated on the same feature flag, so a build cannot expose "create" without "finish".
  const srcTools = fs.readFileSync(SRC_TOOLS_TS, 'utf8');
  const goalGate = /const GoalTool = feature\('(\w+)'\)/.exec(srcTools);
  const proposeGate = /const ProposeGoalTool = feature\('(\w+)'\)/.exec(srcTools);
  assert.ok(goalGate, 'GoalTool is no longer feature-gated');
  assert.ok(proposeGate, 'ProposeGoalTool is not feature-gated');
  assert.equal(proposeGate[1], goalGate[1],
    'the two goal tools are gated on different flags, so a build could ship one without the other');
});

test('the tool is exported from the builtin-tools barrel', () => {
  // A tool that compiles but is not exported never reaches src/tools.ts, and a tool that is not
  // in src/tools.ts never reaches the model.
  const barrel = fs.readFileSync(
    path.resolve(ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'index.ts'),
    'utf8',
  );
  assert.match(barrel, /export \{ ProposeGoalTool \} from '\.\/tools\/ProposeGoalTool\/ProposeGoalTool\.js'/,
    'ProposeGoalTool is not exported from the package barrel');
});

test('the adopted bundle contains the tool and the manifest matches', () => {
  const files = fs.readdirSync(DIST).filter((n) => n.endsWith('.js'));
  const defining = files.filter((n) => {
    const p = path.join(DIST, n);
    if (fs.statSync(p).size > 20_000_000) return false;
    return fs.readFileSync(p, 'utf8').includes('ProposeGoalTool = buildTool(');
  });
  assert.equal(defining.length, 1,
    'expected exactly one chunk to define ProposeGoalTool, got ' + defining.length);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-core', 'manifest.json'), 'utf8'));
  // WAS: `fileCount > 1479`, on the theory that adding a tool always adds a chunk + its map.
  // R412 disproved that: extracting submitFeedback into src/services changed chunk boundaries,
  // the count went 1481 -> 1479, and the tool was adopted correctly. File count measures the
  // bundler's decisions, not adoption. The real evidence is that the definition is reachable and
  // the manifest's own hashes describe the tree on disk.
  assert.ok(manifest.bundle.fileCount > 1000,
    'the manifest describes an implausibly small tree: the build output looks wrong');

  const entry = path.join(DIST, 'cli-bun.js');
  const entrySha = crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
  assert.equal(manifest.bundle.entrySha256, entrySha,
    'the manifest does not describe the entry on disk: the rebuild was not adopted');
});
