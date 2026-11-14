// R453: nothing blocks `-i` — the protection is a prompt sentence, an editor stub, and a 30-min timeout.
//
// THE CLAIM
//   BashTool prompt.ts:116
//     "- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since
//      they require interactive input which is not supported."
//
//   That is an instruction TO THE MODEL. This round asked whether code enforces it.
//
// WHAT ENFORCES IT (partial)
//   1. GIT_EDITOR: 'true'  (Shell.ts:358)
//      -> commands that open an EDITOR (commit, and `rebase -i`'s todo via $EDITOR) get a no-op
//         editor. Real mitigation, but narrow: it only covers editor-driven prompts.
//
// WHAT DOES NOT ENFORCE IT
//   2. NO code rejects `-i` / `--interactive`. bashPermissions.ts is 98KB of command analysis and
//      contains zero references to it for rebase/add/checkout/commit.
//   3. GIT_SEQUENCE_EDITOR is NOT set anywhere.
//   4. spawn uses `stdio: ['pipe', 'pipe', 'pipe']` (Shell.ts:368) — stdin is a pipe nobody writes
//      to, so a command reading stdin waits forever rather than failing fast.
//
// THE FAILURE WINDOW
//   5. DEFAULT_TIMEOUT = 30 * 60 * 1000 (Shell.ts:45). A stdin-blocked command hangs for 30 minutes.
//   6. There IS a 15-second auto-background (ASSISTANT_BLOCKING_BUDGET_MS), but it requires
//      `feature('KAIROS') && getKairosActive()`. KAIROS is in DEFAULT_BUILD_FEATURES, yet
//      kairosActive is set from a GrowthBook flag (src/assistant/gate.ts:9,
//      tengu_kairos_assistant) — a remote kill switch that is off unless the service says otherwise.
//      So in a normal session the 15s rescue does NOT apply.
//
// SO: the residual risk is commands that read stdin directly and are not editor-driven —
//   `git add -i`, `git add -p`, `git checkout -p`, `git clean -i`. Those wait on a pipe for 30 min.
//
// This is not a divergence from the contract (which says nothing about it); it is a place where the
// description's promise ("not supported") is weaker than the code's behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const SHELL = path.join(SRC, 'src', 'utils', 'Shell.ts');
const PROMPT = path.join(TOOLS, 'BashTool', 'prompt.ts');
const PERMS = path.join(TOOLS, 'BashTool', 'bashPermissions.ts');
const BASH = path.join(TOOLS, 'BashTool', 'BashTool.tsx');
const GATE = path.join(SRC, 'src', 'assistant', 'gate.ts');

test('no code rejects the -i flag — the warning is prose only', () => {
  // The point of this test is the NEGATIVE. If rejection logic ever appears, the risk below changes
  // and this test should fail to announce it.
  const perms = read(PERMS);
  for (const word of ['--interactive', 'interactiveFlag', 'requiresInteractive', 'requiresTTY']) {
    assert.ok(!perms.includes(word),
      word + ' now appears in bashPermissions: interactive commands may now be rejected, so the '
      + 'residual risk described here is closed');
  }
  // And the prompt still carries the warning, i.e. the claim still relies on model compliance.
  assert.match(read(PROMPT), /Never use git commands with the -i flag/,
    'the warning sentence is gone: if the flag is now blocked in code, update this file');
});

test('GIT_EDITOR is neutralised but GIT_SEQUENCE_EDITOR is not', () => {
  const shell = read(SHELL);
  assert.match(shell, /GIT_EDITOR: 'true'/,
    'the editor stub is gone: commit and rebase-todo prompts would now block');

  // GIT_SEQUENCE_EDITOR being unset is why `rebase -i` still depends on GIT_EDITOR as its fallback.
  // Recording the absence explicitly: if it gets set, rebase -i becomes unconditionally safe.
  const all = [read(SHELL), read(BASH), read(PROMPT)].join('\n');
  assert.ok(!all.includes('GIT_SEQUENCE_EDITOR'),
    'GIT_SEQUENCE_EDITOR is now set: rebase -i is fully neutralised, update the risk note');
});

test('stdin is a pipe nobody writes to — so a stdin reader waits instead of failing', () => {
  const shell = read(SHELL);
  // The piped form.
  assert.match(shell, /stdio: usePipeMode\s*\?\s*\['pipe', 'pipe', 'pipe'\]/,
    'stdio changed: if stdin became "ignore", a stdin reader would fail fast instead of hanging');
  // And the non-pipe form also keeps a pipe for stdin.
  assert.match(shell, /\['pipe', outputHandle\?\.fd, outputHandle\?\.fd\]/,
    'the file-descriptor stdio form changed: stdin handling may differ');
});

test('the hang window is 30 minutes, not 15 seconds', () => {
  const shell = read(SHELL);
  assert.match(shell, /const DEFAULT_TIMEOUT = 30 \* 60 \* 1000/,
    'the default timeout changed: re-derive how long a blocked command can hang');
});

test('the 15-second rescue needs a remote flag that is off by default', () => {
  // This is the subtle part: there IS a fast rescue, but gated on a GrowthBook kill switch.
  const bash = read(BASH);
  assert.match(bash, /const ASSISTANT_BLOCKING_BUDGET_MS = 15_000/,
    'the assistant budget constant changed');
  // The gate and its use are separated by a comment block and a brace, so allow a generous span.
  // A tight {0,200} window failed here once already.
  const gateAt = bash.indexOf("feature('KAIROS') &&");
  assert.ok(gateAt > 0, 'the KAIROS gate is gone from the auto-background condition');
  const applied = bash.indexOf('ASSISTANT_BLOCKING_BUDGET_MS)', gateAt);
  assert.ok(applied > gateAt && applied - gateAt < 2000,
    'the budget is no longer applied near its KAIROS gate: the 15s rescue may now be unconditional');
  const gateWindow = bash.slice(gateAt, gateAt + 900);
  assert.match(gateWindow, /getKairosActive\(\)/,
    'the runtime half of the gate changed');
  assert.match(gateWindow, /isMainThread/,
    'the main-thread restriction changed');

  // The runtime half comes from a remote flag.
  const gate = read(GATE);
  assert.match(gate, /tengu_kairos_assistant/,
    'the growthbook flag name changed: re-derive whether kairosActive can still be off');
  assert.match(gate, /remote kill switch/i,
    'the "remote kill switch" note is gone: confirm whether kairos is now always active');
});

test('the described set of dangerous commands is narrower than git\'s actual stdin readers', () => {
  // The prompt names `git rebase -i` and `git add -i`. GIT_EDITOR='true' protects the first (its todo
  // falls back to $EDITOR) but not the second, nor -p variants. Recording the gap.
  const prompt = read(PROMPT);
  const m = /Never use git commands with the -i flag \(like ([^)]+)\)/.exec(prompt);
  assert.ok(m, 'the example list changed');
  const named = m[1];
  assert.match(named, /rebase -i/, 'rebase -i is no longer named');
  assert.match(named, /add -i/, 'add -i is no longer named');

  // -p / --patch variants read stdin too but are not mentioned anywhere in the prompt.
  assert.ok(!/-p\b.*patch|--patch/.test(prompt),
    'the prompt now mentions --patch: the documented set has widened, update this note');
});
