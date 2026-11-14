// R450: description self-consistency audit — the sandbox claim is conditional, not contradictory.
//
// THE APPARENT CONTRADICTION
//   BashTool's prompt contains, verbatim:
//       'Commands cannot run outside the sandbox under any circumstances.'
//   while its input schema declares:
//       dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional())
//         .describe('Set this to true to dangerously override sandbox mode and run commands
//                    without sandboxing.')
//
//   A schema field that disables the sandbox sitting beside prose saying sandbox escape is
//   impossible looks like a defect. It is not.
//
// WHY IT IS NOT A DEFECT
//   Both texts come from ONE conditional:
//
//       const allowUnsandboxedCommands = SandboxManager.areUnsandboxedCommandsAllowed()
//       const sandboxOverrideItems = allowUnsandboxedCommands
//         ? [ 'You should always default to running commands within the sandbox...',
//             "Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)",
//             'This will prompt the user for permission', ... ]
//         : [ 'All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is
//              disabled by policy.',
//             'Commands cannot run outside the sandbox under any circumstances.', ... ]
//
//   Mutually exclusive branches, each internally consistent. The model never sees both.
//
// WHAT IS STILL WORTH RECORDING
//   1. The default is PERMISSIVE: `allowUnsandboxedCommands ?? true`. So in an unconfigured session
//      the model reads the escape instructions, not the prohibition.
//   2. That branch says "don't ask, just do it" and then "This will prompt the user for permission".
//      Adjacent sentences with opposite tone — deliberate (the retry is unconditional, the permission
//      prompt is what happens next), but a reader can misread it as "silently bypass".
//   3. `shouldUseSandbox.ts` states plainly that excludedCommands is "a user-facing convenience
//      feature, not a security boundary", and that the permission system is the real control.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const BASH_PROMPT = path.join(TOOLS, 'BashTool', 'prompt.ts');
const BASH_TOOL = path.join(TOOLS, 'BashTool', 'BashTool.tsx');
const SANDBOX_DECIDE = path.join(TOOLS, 'BashTool', 'shouldUseSandbox.ts');
const SANDBOX_ADAPTER = path.join(SRC, 'src', 'utils', 'sandbox', 'sandbox-adapter.ts');

test('the "cannot run outside the sandbox" line lives in the DENY branch only', () => {
  const prompt = read(BASH_PROMPT);
  const denyAt = prompt.indexOf('Commands cannot run outside the sandbox under any circumstances');
  assert.ok(denyAt > 0, 'the prohibition sentence is gone');

  // It must sit after the ternary's `: [` — i.e. in the false arm.
  const before = prompt.slice(0, denyAt);
  const ternaryAt = before.lastIndexOf('allowUnsandboxedCommands');
  assert.ok(ternaryAt > 0, 'the branch condition is gone: re-derive whether this is still conditional');

  // And the allow-branch escape instruction must be BEFORE the ternary flip.
  const escapeAt = prompt.indexOf('dangerouslyDisableSandbox: true` (don\'t ask, just do it)');
  assert.ok(escapeAt > 0, 'the escape instruction is gone');
  assert.ok(escapeAt < denyAt,
    'the escape instruction and the prohibition are no longer in opposite branches: they may now '
    + 'both reach the model, which WOULD be a contradiction');
});

test('the branch is driven by a runtime setting, not a constant', () => {
  const prompt = read(BASH_PROMPT);
  assert.match(prompt, /const allowUnsandboxedCommands\s*=\s*SandboxManager\.areUnsandboxedCommandsAllowed\(\)/,
    'the branch no longer reads the sandbox manager');

  const adapter = read(SANDBOX_ADAPTER);
  assert.match(adapter, /function areUnsandboxedCommandsAllowed\(\): boolean \{[\s\S]{0,200}?allowUnsandboxedCommands \?\? true/,
    'the setting no longer defaults to true: the permissive default is what makes this worth noting');
});

test('the permissive default means an unconfigured session sees the escape instructions', () => {
  // Not a bug — a fact that changes what the model is told by default. Recorded so it is not
  // rediscovered as a surprise.
  const adapter = read(SANDBOX_ADAPTER);
  const m = /function areUnsandboxedCommandsAllowed\(\): boolean \{[\s\S]{0,200}?return settings\?\.sandbox\?\.allowUnsandboxedCommands \?\? (\w+)/.exec(adapter);
  assert.ok(m, 'the default expression changed shape');
  assert.equal(m[1], 'true',
    'the default is no longer permissive: an unconfigured session now sees the prohibition branch');
});

test('the escape branch still tells the model a permission prompt follows', () => {
  // The sentence pair that reads like a contradiction but is not: "don't ask, just do it" refers to
  // the retry, and the next line says the user will be prompted. If the prompt sentence disappeared,
  // "just do it" would then mean "bypass silently", which would be a real problem.
  const prompt = read(BASH_PROMPT);
  assert.match(prompt, /This will prompt the user for permission/,
    'the permission-prompt sentence is gone: "don\'t ask, just do it" would now mean bypass silently');
});

test('excludedCommands is documented as convenience, not a security boundary', () => {
  // The code says so itself. Worth pinning: if that comment ever changes to claim it IS a boundary,
  // the security story in the description changes with it.
  const decide = read(SANDBOX_DECIDE);
  assert.match(decide, /not a security boundary/i,
    'the "not a security boundary" note is gone: re-derive what the description may now promise');
  // The sentence wraps across a comment line break, so match with whitespace tolerance rather than
  // a literal space. (A single-space regex failed here on the CRLF + "// " continuation.)
  assert.match(decide, /sandbox permission\s*(?:\r?\n\/\/\s*)?system[^.]{0,40}is the actual security control/i,
    'the note about where the real control lives is gone');
});

test('dangerouslyDisableSandbox actually affects the decision, gated by the setting', () => {
  // The field is honoured, and only when allowed. Both halves matter: honoured-but-ungated would be
  // an escape; declared-but-ignored would be a dead field.
  const decide = read(SANDBOX_DECIDE);
  const m = /input\.dangerouslyDisableSandbox\s*&&\s*SandboxManager\.areUnsandboxedCommandsAllowed\(\)/.exec(decide);
  assert.ok(m, 'the gate changed: the flag may now be honoured without the setting, or ignored entirely');

  // And the schema declares it.
  const tool = read(BASH_TOOL);
  assert.match(tool, /dangerouslyDisableSandbox:\s*semanticBoolean\(z\.boolean\(\)\.optional\(\)\)/,
    'the input field is gone');
});
