// Bash: the approval gate, then real output with an exit code.
//
// MEASURED LIVE (replica :10340). Prompt: "Run node --version with the Bash tool, then tell me
// the exact version string it printed. Use the tool, do not guess."
//
// The turn did NOT run immediately. The UI showed an approval card:
//   "允许 Claude 运行 吗？  Run: node --version  auto mode still confirms commands
//    [拒绝 Esc]  [允许一次 Ctrl+⏎]"
// and the session stayed isRunning:true with 0 rows until the card was answered.
//
// After clicking 允许一次 the turn finished in under 3 seconds with 4 rows:
//   assistant  tool_use Bash { command: 'node --version' }
//   user       tool_result "v24.19.0\n[exit 0]"
//   assistant  "`node --version` printed: v24.19.0 (exit code 0)"
//
// v24.19.0 matches the host's actual Node version, so this was a real process, not a canned
// string. The [exit 0] suffix is what lets the model distinguish a version from a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('a Bash command asks for approval before it runs', () => {
  // Measured: auto mode still confirms. The action is EXEC (not RUN_COMMAND).
  const permissions = read('desktop/permissions.cjs');
  assert.match(permissions, /const ACTIONS = Object\.freeze\(\{/, 'the action table is gone');
  assert.match(permissions, /EXEC: 'exec'/, 'there is no exec action');
  // And auto mode must NOT pre-approve it: only READ and EDIT are free there.
  const autoBlock = permissions.slice(permissions.indexOf('auto mode reads freely') - 400,
    permissions.indexOf('auto mode reads freely') + 260);
  assert.doesNotMatch(autoBlock, /ACTIONS\.EXEC\) return result\(false/, 'auto mode pre-approves exec');
});

test('the approval card shows the exact command', () => {
  // "Run: node --version" — the user must see what they are approving.
  const approval = read('desktop/tool-approval.cjs');
  assert.match(approval, /return `Run: \$\{input\.command\}`;/, 'the card no longer shows the command');
});

test('the command output carries an exit code', () => {
  // Measured: 'v24.19.0\n[exit 0]'. Without it a non-zero exit looks like normal output.
  const source = read('desktop/local-exec.cjs') + read('desktop/tools.cjs');
  assert.match(source, /\[exit /, 'the exit code is not appended to the output');
});

test('a denied or timed-out approval never runs the command', () => {
  // Round 238 measured `if (decision !== 'allow')` in tool-approval: a timeout refuses too.
  const approval = read('desktop/tool-approval.cjs');
  assert.match(approval, /if \(decision !== 'allow'\) \{/, 'the approve-only gate is gone');
});

test('the allowlist is still enforced after approval', () => {
  // Approval lets THIS command run; it does not widen the executable allowlist.
  const localExec = read('desktop/local-exec.cjs');
  assert.match(localExec, /ALLOWED_EXECUTABLES/, 'the allowlist is gone');
});