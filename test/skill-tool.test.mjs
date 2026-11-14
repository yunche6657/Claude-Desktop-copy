// The agent must be able to OPEN a skill, not just hear about it.
//
// The system prompt lists the installed skills, but they live in the installed app's
// directory, outside the approved workspace roots, so the Read tool refuses them. The
// agent therefore knew a skill existed and could never read it -- it could only
// improvise, which is exactly what the skill is there to replace.
//
// The Skill tool closes that gap without widening Read: it takes a skill NAME and
// resolves the path itself, so it cannot be used to escape the roots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { defineTools } = require(path.join(ROOT, 'desktop', 'tools.cjs'));

/** A fake installation shipping the given skills, plus an empty workspace store. */
function fixture(skills) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltool-home-'));
  const runtime = path.join(home, 'AppData', 'Local', 'Claude-3p',
    'local-agent-mode-sessions', 'skills-plugin', 'acct', 'rt', 'skills');
  for (const [name, files] of Object.entries(skills)) {
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(runtime, name, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, 'utf8');
    }
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltool-ws-'));
  fs.mkdirSync(path.join(workspace, '.data'), { recursive: true });
  return { home, workspace };
}

function skillTool(home, workspace) {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, CLAUDE_WORKSPACE: process.env.CLAUDE_WORKSPACE };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.CLAUDE_WORKSPACE = workspace;
  const tools = defineTools({ workspaceRoot: workspace, allowedRoots: [workspace] });
  const tool = tools.find((entry) => entry.name === 'Skill');
  tool.restore = () => {
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.CLAUDE_WORKSPACE === undefined) delete process.env.CLAUDE_WORKSPACE; else process.env.CLAUDE_WORKSPACE = saved.CLAUDE_WORKSPACE;
  };
  return tool;
}

const md = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions.\n`;

test('Skill is a read-only tool, so it never prompts', () => {
  const { home, workspace } = fixture({ docx: { 'SKILL.md': md('docx', 'Word.') } });
  const tool = skillTool(home, workspace);
  try {
    assert.equal(tool.action, 'read', 'reading a skill must not require approval');
  } finally { tool.restore(); }
});

test('listing skills needs no argument', async () => {
  const { home, workspace } = fixture({
    docx: { 'SKILL.md': md('docx', 'Word documents.') },
    pdf: { 'SKILL.md': md('pdf', 'PDF files.') },
  });
  const tool = skillTool(home, workspace);
  try {
    const result = await tool.handler({});
    assert.ok(result.content.includes('docx'));
    assert.ok(result.content.includes('pdf'));
  } finally { tool.restore(); }
});

test('naming a skill returns its instructions', async () => {
  const { home, workspace } = fixture({
    docx: { 'SKILL.md': md('docx', 'Word documents.'), 'scripts/build.py': 'print(1)\n' },
  });
  const tool = skillTool(home, workspace);
  try {
    const result = await tool.handler({ name: 'docx' });
    assert.ok(result.content.includes('Instructions.'), 'the body must come back');
    assert.ok(result.content.includes('scripts/build.py'), 'and the list of files it ships, so the agent knows what else to ask for');
  } finally { tool.restore(); }
});

test('one named file inside a skill can be read', async () => {
  const { home, workspace } = fixture({
    docx: { 'SKILL.md': md('docx', 'Word.'), 'REFERENCE.md': 'Deep reference.\n' },
  });
  const tool = skillTool(home, workspace);
  try {
    const result = await tool.handler({ name: 'docx', file: 'REFERENCE.md' });
    assert.ok(result.content.includes('Deep reference.'));
  } finally { tool.restore(); }
});

test('an unknown skill is refused with the list of real ones', async () => {
  const { home, workspace } = fixture({ docx: { 'SKILL.md': md('docx', 'Word.') } });
  const tool = skillTool(home, workspace);
  try {
    await assert.rejects(() => tool.handler({ name: 'nope' }), (error) => {
      assert.ok(error.message.includes('docx'), 'the error must say what does exist');
      return true;
    });
  } finally { tool.restore(); }
});

test('a path cannot be passed where a name is expected', async () => {
  // This is the whole reason the tool takes a name: it must not become a way to
  // read outside the approved roots.
  const { home, workspace } = fixture({ docx: { 'SKILL.md': md('docx', 'Word.') } });
  const tool = skillTool(home, workspace);
  try {
    await assert.rejects(() => tool.handler({ name: '../../../etc/passwd' }));
    await assert.rejects(() => tool.handler({ name: 'docx', file: '../../../etc/passwd' }));
  } finally { tool.restore(); }
});

test('with no skills installed it says so instead of throwing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltool-empty-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltool-ws-'));
  fs.mkdirSync(path.join(workspace, '.data'), { recursive: true });
  const tool = skillTool(home, workspace);
  try {
    const result = await tool.handler({});
    assert.match(result.content, /No skills are installed/i);
  } finally { tool.restore(); }
});
test('opening a skill does not raise an approval card', () => {
  // Measured live before this was fixed: asking the agent to open "docx" produced
  // "允许 Claude 运行 Skill 吗？" because Skill was missing from the action table and
  // therefore fell back to EDIT. Reading a skill must behave exactly like Read.
  const { actionFor, describeRequest } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));
  const { decide } = require(path.join(ROOT, 'desktop', 'permissions.cjs'));
  assert.equal(actionFor('Skill'), 'read', 'Skill must be a read action');
  for (const mode of ['ask', 'plan', 'acceptEdits', 'auto', 'dontAsk']) {
    assert.equal(decide(mode, actionFor('Skill')).prompt, false, `no prompt in ${mode} mode`);
  }
  assert.match(describeRequest({ name: 'Skill', input: { name: 'docx' } }), /docx/);
});

test('an unlisted tool still prompts', () => {
  // The conservative default has to survive: adding Skill must not widen it.
  const { actionFor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));
  const { decide } = require(path.join(ROOT, 'desktop', 'permissions.cjs'));
  assert.equal(actionFor('TotallyUnknownTool'), 'edit');
  assert.equal(decide('ask', actionFor('TotallyUnknownTool')).prompt, true);
});
