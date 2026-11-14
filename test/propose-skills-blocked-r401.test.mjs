// R401: ProposeSkills is BLOCKED on a missing review-card UI, and this file pins the evidence.
//
// WHY A TEST INSTEAD OF CODE
//   worklist §3.2 asks for ProposeSkills against a "semantic mismatch". Investigating first (as
//   R400's handoff required) showed the mismatch is not renameable: the official tool only
//   PROPOSES (output is `{ proposalCount }`, and its doc says "when the user saves…"), while the
//   only skill-writing path in CCB (`writeLearnedSkill`) writes straight to disk, and CCB has no
//   review-card component at all. Implementing it either way produces a tool that is "fields
//   right, meaning wrong" or "meaning approximated, does nothing".
//
//   So the honest deliverable is a recorded blocker. These assertions fail loudly if someone
//   later implements ProposeSkills WITHOUT addressing the blocker — which is the whole point:
//   a silent half-implementation would look like progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');

function srcFile(rel) {
  const p = path.join(SRC, rel);
  assert.ok(fs.existsSync(p),
    'the pinned CCB source tree is missing ' + rel + '; re-fetch it (see R396 handoff)');
  return fs.readFileSync(p, 'utf8');
}

test('CCB still has no review-card component, which is why the tool is blocked', () => {
  // The blocker, stated as a measurement rather than as prose. If a review card appears, the
  // "blocked" verdict should be revisited and this test will say so.
  const skillsDir = path.join(SRC, 'src', 'components', 'skills');
  assert.ok(fs.existsSync(skillsDir), 'the skills component directory moved');
  const files = fs.readdirSync(skillsDir);
  assert.ok(files.includes('SkillsMenu.tsx'),
    'SkillsMenu.tsx is gone; the component layout changed and this analysis needs redoing');

  // No component anywhere should be able to show pending skill proposals.
  const componentsRoot = path.join(SRC, 'src', 'components');
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, acc);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) acc.push(full);
    }
    return acc;
  };
  const hits = walk(componentsRoot).filter((f) =>
    /proposalCount|ProposeSkills|skillProposal/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map((f) => path.relative(SRC, f)), [],
    'a skill-proposal UI appeared: the §3.2 blocker may be resolved, so revisit it instead of '
    + 'leaving this test green');
});

test('the only skill-writing path writes straight to disk', () => {
  // This is what makes "just reuse it" wrong: the official tool must NOT persist on its own.
  const gen = srcFile(path.join('src', 'services', 'skillLearning', 'skillGenerator.ts'));
  assert.match(gen, /export async function writeLearnedSkill/,
    'writeLearnedSkill is gone; re-derive how skills get written');
  assert.match(gen, /await writeFile\(filePath, draft\.content, 'utf8'\)/,
    'writeLearnedSkill no longer writes SKILL.md immediately, so the blocker changed');

  // There is no separate "stage this proposal" step next to it.
  assert.ok(!/export (async )?function (stage|queue|defer)Skill/.test(gen),
    'a staging/queue function appeared: ProposeSkills may now be implementable without UI');
});

test('skillLearning is gated twice, and the build flag is still off', () => {
  // A common misreading: "the functions are in the bundle, so the feature works". They are in the
  // bundle only because another enabled feature imports them.
  const check = srcFile(path.join('src', 'services', 'skillLearning', 'featureCheck.ts'));
  assert.match(check, /feature\('SKILL_LEARNING'\)/,
    'the build-time gate is gone from featureCheck.ts');
  assert.match(check, /SKILL_LEARNING_ENABLED === '1'/,
    'the runtime gate is gone from featureCheck.ts');

  const defines = srcFile(path.join('scripts', 'defines.ts'));
  // Find the DEFAULT_BUILD_FEATURES array and check the flag is commented out there.
  const at = defines.indexOf('DEFAULT_BUILD_FEATURES');
  assert.ok(at > 0, 'DEFAULT_BUILD_FEATURES is gone');
  const start = defines.indexOf('[', at);
  let depth = 0;
  let end = -1;
  for (let i = start; i < defines.length; i += 1) {
    if (defines[i] === '[') depth += 1;
    else if (defines[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const block = defines.slice(start, end + 1);
  const active = block.split('\n').some((line) =>
    !line.trim().startsWith('//') && line.includes("'SKILL_LEARNING'"));
  assert.equal(active, false,
    'SKILL_LEARNING is now enabled in the default build: the whole skillLearning subsystem '
    + 'becomes reachable, so the §3.2 analysis must be redone');
});

test('ProposeSkills is absent from the tool table', () => {
  // The claim being made to the user is "not implemented". This is the measurement of it.
  const dist = path.join(ROOT, 'agent-core', 'claude-code', 'dist');
  const tableFile = fs.readdirSync(dist)
    .filter((n) => n.endsWith('.js') && fs.statSync(path.join(dist, n)).size < 20_000_000)
    .find((n) => fs.readFileSync(path.join(dist, n), 'utf8').includes('function getAllBaseTools()'));
  assert.ok(tableFile, 'the tool table is missing from the vendored bundle');
  const table = fs.readFileSync(path.join(dist, tableFile), 'utf8');
  const body = table.slice(table.indexOf('function getAllBaseTools()'));
  assert.ok(!body.includes('ProposeSkillsTool'),
    'ProposeSkillsTool is registered: §3.2 was implemented, so update the worklist and this file');
  // Contrast: ProposeGoal WAS added in R400. Keeping the assertion makes the difference explicit.
  assert.ok(body.includes('ProposeGoalTool'),
    'ProposeGoalTool vanished, which contradicts the R400 addition');
});

test('the official tool accepts 1..3 proposals and refuses reserved names', () => {
  // Recorded so a future implementation cannot claim alignment with a guessed shape.
  const dts = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
  assert.ok(fs.existsSync(dts), 'the official sdk-tools.d.ts is missing from .tmp/cc-contract');
  const text = fs.readFileSync(dts, 'utf8');
  assert.match(text, /@minItems 1[\s\S]{0,80}@maxItems 3/,
    'the official 1..3 proposals bound changed');
  assert.match(text, /must not contain "claude" or "anthropic"/,
    'the reserved-name rule changed');
  assert.match(text, /export interface ProposeSkillsOutput \{[\s\S]{0,200}proposalCount: number/,
    'ProposeSkillsOutput no longer returns only a count, which was the basis for "it does not '
    + 'persist"');
});
