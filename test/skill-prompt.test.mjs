// The model has to be told which skills exist.
//
// Showing eleven skills on the Customize > Skills page is not the same as the agent
// being able to use them: the system prompt was three fixed sentences that never
// mentioned a skill, so a request for a .docx produced a hand-rolled script while the
// docx skill sat on disk. The page was decoration.
//
// These tests pin the prompt side of that contract, independent of this host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildSystemPrompt } = require(path.join(ROOT, 'desktop', 'agent-config.cjs'));

const skill = (name, description) => ({ name, description, enabled: true });

test('a skill catalogue reaches the system prompt', () => {
  const prompt = buildSystemPrompt([skill('docx', 'Create Word documents.')]);
  assert.ok(prompt.includes('docx'), 'the skill name must be present');
  assert.ok(prompt.includes('Create Word documents.'), 'and the description that decides when it applies');
});

test('the base instructions survive the addition', () => {
  const withSkills = buildSystemPrompt([skill('pdf', 'PDF files.')]);
  assert.ok(withSkills.startsWith('You are Claude Code'), 'the role must still lead the prompt');
  assert.ok(withSkills.includes('Use the provided tools'), 'the tool guidance must still be there');
});

test('no skills means exactly the original prompt', () => {
  // A machine with no skills must not grow a dangling "following skills are installed".
  const prompt = buildSystemPrompt([]);
  assert.equal(prompt.includes('skills'), false, 'no skill section when there is nothing to list');
  assert.ok(prompt.startsWith('You are Claude Code'));
});

test('every catalogue entry appears once, in order', () => {
  const prompt = buildSystemPrompt([
    skill('alpha', 'First.'),
    skill('beta', 'Second.'),
    skill('gamma', 'Third.'),
  ]);
  const alpha = prompt.indexOf('alpha');
  const beta = prompt.indexOf('beta');
  const gamma = prompt.indexOf('gamma');
  assert.ok(alpha > 0 && beta > alpha && gamma > beta, 'entries keep the catalogue order');
  assert.equal(prompt.split('- alpha').length - 1, 1, 'each entry is listed once');
});

test('a skill with no description still gets a usable line', () => {
  const prompt = buildSystemPrompt([skill('bare', '')]);
  assert.ok(prompt.includes('- bare'), 'the name alone is enough');
  assert.equal(prompt.includes('undefined'), false, 'no undefined leaks into the prompt');
});

test('the prompt tells the model to prefer the skill over improvising', () => {
  // Without this sentence a listed skill is still just trivia the model may ignore.
  const prompt = buildSystemPrompt([skill('docx', 'Word documents.')]);
  assert.ok(/follow that skill|rather than improvising/i.test(prompt),
    'the instruction must say what to DO with the list');
});

test('the catalogue shape is name + description only, never files', () => {
  // The prompt is rebuilt on every message, so it must not carry SKILL.md bodies or
  // file lists. skillCatalogue() produces exactly {name, description, enabled}.
  const entries = [
    { name: 'docx', description: 'Word documents.', enabled: true },
    { name: 'pdf', description: 'PDF files.', enabled: true },
  ];
  const prompt = buildSystemPrompt(entries);
  assert.equal(prompt.includes('SKILL.md'), false, 'no file contents leak in');
  assert.equal(/\bfiles\b\s*:/i.test(prompt), false, 'no file listings');
  // One line per skill, plus the fixed base and the one-line instruction.
  const skillLines = prompt.split(String.fromCharCode(10)).filter((line) => line.startsWith('- '));
  assert.equal(skillLines.length, entries.length, 'exactly one line per skill');
});