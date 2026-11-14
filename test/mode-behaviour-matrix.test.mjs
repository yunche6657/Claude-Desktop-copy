// Every mode must behave the way classify() says it does — no mode may be an exception.
//
// Measured this round by running the real executor once per mode:
//
//   mode                classify  asked/ran
//   ask                 ask       1/1
//   acceptEdits         ask       1/1   (exec still asks; edits would not)
//   bypassPermissions   allow     0/1
//   plan                ask       1/1
//   auto                ask       1/1
//   default             ask       1/1
//   dontAsk             deny      0/0
//
// This is the cross-check that would have caught the last two rounds' bugs directly:
//   round 184: dontAsk asked (1/1 where classify said deny -> 0/0)
//   round 185: the Files service asked for dontAsk writes
// A table like this turns "does every mode behave as documented" into one run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createApprovalExecutor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));
const { MODES, ACTIONS, DECISIONS, classify } = require(path.join(ROOT, 'desktop', 'permissions.cjs'));

/** Run one command through the executor and report whether it asked / ran. */
async function probe(mode) {
  const seen = { asked: 0, ran: 0 };
  const exec = createApprovalExecutor({
    mode,
    onEvent: () => {},
    ask: async () => { seen.asked++; return 'allow'; },
    tools: [{
      name: 'Bash',
      action: 'exec',
      handler: async () => { seen.ran++; return { content: 'ran' }; },
    }],
  });
  await exec({ name: 'Bash', input: { command: 'node -v' } });
  return seen;
}

test('every mode behaves as classify() describes for a command', async () => {
  for (const mode of Object.values(MODES)) {
    const verdict = classify(mode, ACTIONS.EXEC);
    const seen = await probe(mode);
    const expectAsked = verdict === DECISIONS.ASK ? 1 : 0;
    const expectRan = verdict === DECISIONS.DENY ? 0 : 1;
    assert.equal(seen.asked, expectAsked,
      mode + ': classify says ' + verdict + ' but asked=' + seen.asked);
    assert.equal(seen.ran, expectRan,
      mode + ': classify says ' + verdict + ' but ran=' + seen.ran);
  }
});

test('no mode asks and then refuses a granted approval', async () => {
  // If a mode prompts and the user allows, the tool must run. A mode that asks and then
  // still refuses is worse than one that never asked: the click was wasted.
  //
  // (An earlier version of this test also banned "neither asks nor runs", which is exactly
  // what dontAsk must do — the assertion contradicted the test below it.)
  for (const mode of Object.values(MODES)) {
    const seen = await probe(mode);
    assert.equal(seen.asked === 1 && seen.ran === 0, false,
      mode + ': asked, then refused even after approval');
  }
});

test('dontAsk is the only mode that refuses without asking', async () => {
  const silentRefusals = [];
  for (const mode of Object.values(MODES)) {
    const seen = await probe(mode);
    if (seen.asked === 0 && seen.ran === 0) silentRefusals.push(mode);
  }
  assert.deepEqual(silentRefusals, [MODES.DONT_ASK],
    'these modes refuse without asking: ' + silentRefusals.join(', '));
});
