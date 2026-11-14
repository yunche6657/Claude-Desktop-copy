// The session's permission mode must reach the tool-approval decision.
//
// The composer stores 自动 / 手动 / 接受编辑 / 计划 on the session record. Getting that
// value to the approval decision took several fixes, because the mode travels through a
// chain and each hop used its own default:
//
//   session-kernel -> createAgent({...})   no permissionMode   -> process default (ask)
//   local-kernel   -> agent.run({...})     no permissionMode   -> process default (ask)
//   agent-config   -> run() read config    ignored the session
//   main.cjs       -> one cached runner, () => getAgent()       -> argument dropped
//
// Measured on the live replica: session.permissionMode = 'auto' while the approval card
// subtitle read 'ask mode prompts before edits and commands', and both Write and Bash kept
// prompting in a session the user had set to 自动.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, 'desktop', name), 'utf8');

test('the in-process turn path carries the mode end to end', () => {
  const kernel = read('session-kernel.cjs');
  const at = kernel.indexOf('createAgent({');
  assert.ok(at > 0, 'the createAgent turn path must exist');
  assert.match(kernel.slice(at, at + 400), /permissionMode:\s*session\.permissionMode/);

  const local = read('local-kernel.cjs');
  assert.match(local, /opts\.permissionMode/, 'local-kernel must read it from the turn options');
  const runAt = local.indexOf('await agent.run({');
  assert.ok(runAt > 0, 'agent.run must exist');
  assert.match(local.slice(runAt, runAt + 400), /permissionMode,/, 'agent.run must receive it');
});

test('the CCB turn path carries the selected session mode at spawn and between turns', () => {
  const kernel = read('session-kernel.cjs');
  const at = kernel.indexOf('await backend.sendMessage(');
  assert.ok(at > 0, 'the backend turn path must exist');
  assert.match(kernel.slice(at, at + 900), /permissionMode:\s*sessions\.get\(sessionId\)\?\.permissionMode/);
  const ccb = read('ccb-kernel.cjs');
  assert.match(ccb, /args\.push\('--permission-mode', state\.permissionMode\)/);
  assert.match(ccb, /sendControl\(state, 'set_permission_mode', \{ mode \}/);
  assert.match(ccb, /state\.appliedPermissionMode === 'bypassPermissions'/);
});

test('the runner resolves the mode per run, not once at construction', () => {
  const config = read('agent-config.cjs');
  assert.match(config, /const effectiveMode = VALID_MODES\.has\(permissionMode\)/, 'it must validate the per-run value');
  const executor = config.slice(config.indexOf('createApprovalExecutor({'));
  assert.match(executor.slice(0, 300), /mode:\s*effectiveMode/, 'the executor takes the resolved mode');
  assert.doesNotMatch(executor.slice(0, 300), /mode:\s*config\.permissionMode/, 'must not bypass the per-run mode');
});
