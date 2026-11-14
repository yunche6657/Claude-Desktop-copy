// dontAsk must deny without asking — the one thing its own description promises.
//
// Measured before this fix: the executor read only `policy.prompt`, so dontAsk fell into
// the same branch as ask/plan/acceptEdits and opened an approval card. The user picked
// "Don't ask" in the menu and was then asked to approve every edit and command.
//
// After wiring classify() in:
//   mode=dontAsk, tool=Bash  -> asked:0  ran:0  isError:true  event:tool_denied
//   content: 'Bash was not run: dontAsk: not pre-approved, and this mode never prompts to approve'
//
// The reason matters as much as the refusal: a bare "denied" gives the model nothing to
// work with, while a named cause lets it switch approach instead of retrying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createApprovalExecutor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));

/** Run one tool request through the executor and report what happened. */
async function attempt(mode, { answer = 'allow' } = {}) {
  const seen = { asked: 0, ran: 0, events: [] };
  // The executor runs `tools[].handler` itself; there is no second `run` callback to pass.
  // The first version of this helper assumed one and every "did it run" assertion was
  // measuring a function that was never called.
  const exec = createApprovalExecutor({
    mode,
    onEvent: (e) => seen.events.push(e.type),
    ask: async () => { seen.asked++; return answer; },
    tools: [{
      name: 'Bash',
      action: 'exec',
      handler: async () => { seen.ran++; return { content: 'ran' }; },
    }],
  });
  const result = await exec({ name: 'Bash', input: { command: 'node -v' } });
  return { ...seen, result };
}

test('dontAsk refuses a command without ever asking', async () => {
  const run = await attempt('dontAsk');
  assert.equal(run.asked, 0, 'dontAsk opened an approval prompt');
  assert.equal(run.ran, 0, 'dontAsk ran the command');
  assert.equal(run.result.isError, true);
  assert.ok(run.events.includes('tool_denied'), 'no denial event was emitted');
});

test('the refusal names the cause so the model can change approach', async () => {
  const run = await attempt('dontAsk');
  assert.match(String(run.result.content), /not run/i, 'the message does not say it was not run');
  assert.match(String(run.result.content), /not pre-approved|never prompts/i,
    'the message does not explain why');
});

test('ask mode still asks, and honours the answer', async () => {
  // The deny branch must not swallow the modes that genuinely need a prompt.
  const run = await attempt('ask');
  assert.equal(run.asked, 1, 'ask mode did not prompt');
  assert.equal(run.ran, 1, 'ask mode did not run after approval');
});

test('a declined prompt does not run the tool', async () => {
  const run = await attempt('ask', { answer: 'deny' });
  assert.equal(run.ran, 0);
  assert.equal(run.result.isError, true);
});

test('bypassPermissions runs without asking', async () => {
  const run = await attempt('bypassPermissions');
  assert.equal(run.asked, 0);
  assert.equal(run.ran, 1);
  assert.equal(run.result.isError, undefined);
});

test('acceptEdits runs edits without asking but still asks for commands', async () => {
  const run = await attempt('acceptEdits');
  assert.equal(run.asked, 1, 'acceptEdits should still ask before running a command');
  assert.equal(run.ran, 1);
});
