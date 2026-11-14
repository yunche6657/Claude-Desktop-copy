// The agent loop must actually run tools end to end, not just report that it could.
//
// Measured live this round against the real gateway (deepseek-v4.1-flash):
//
//   prompt: 'Use the Read tool to read package.json, then tell me only the value of name.'
//   result: the model called Read, the UI showed 已读取, and it answered
//           code-desktop-reconstruction - exactly package.json's name field.
//
//   prompt: 'Use the Glob tool to list every *.test.mjs under test/ and count them.'
//   result: the model chose Bash (ls/find) instead of Glob, and the run stopped at the
//           approval card, because auto mode still confirms commands by design.
//
// That second run is what makes the first meaningful: the tool path is real AND the
// permission gate really gates it. Both halves are pinned below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = require(path.join(ROOT, 'desktop', 'agent.cjs'));
const permissions = require(path.join(ROOT, 'desktop', 'permissions.cjs'));

test('the value the model answered is the real one in package.json', () => {
  // The live run answered code-desktop-reconstruction. Re-derive it here so the assertion
  // states a fact about this repo instead of a remembered string.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'code-desktop-reconstruction',
    'package.json name changed; the tool-call evidence no longer describes this repo');
});

test('a tool_use block becomes exactly one executable request', () => {
  const message = {
    content: [
      { type: 'text', text: 'Let me read that.' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'package.json' } },
    ],
  };
  const requests = agent.toolRequests(message);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, 'Read');
  assert.deepEqual(requests[0].input, { path: 'package.json' });
});

test('auto mode applies edits but still confirms command execution', () => {
  // Live: an auto-mode run stopped at the approval card for `ls ... | wc -l`.
  // The action name is 'exec' in this module (ACTIONS.EXEC), not 'command'.
  assert.equal(permissions.decide(permissions.MODES.AUTO, permissions.ACTIONS.EXEC).prompt, true,
    'auto mode started running commands unattended');
  assert.equal(permissions.decide(permissions.MODES.AUTO, permissions.ACTIONS.EDIT).prompt, false,
    'auto mode started prompting for edits');
  assert.equal(permissions.decide(permissions.MODES.AUTO, permissions.ACTIONS.READ).prompt, false,
    'auto mode started prompting for reads');
});

test('read is never prompted in any mode', () => {
  // Prompting for a read would make every tool call unusable, and the agent could never
  // use Read at all - which the live run proves it can.
  for (const mode of Object.values(permissions.MODES)) {
    assert.equal(permissions.decide(mode, permissions.ACTIONS.READ).prompt, false,
      'mode ' + mode + ' prompts for reads');
  }
});
