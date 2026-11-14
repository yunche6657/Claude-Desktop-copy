// The session's own permission mode must decide whether a tool prompts.
//
// The composer offers 自动 / 手动 / 接受编辑 / 计划 / 跳过确认 and stores the choice on
// the session record. The agent runner ignored it and always used the process config,
// whose default is ask. Measured on the live replica:
//
//   session.permissionMode = 'auto'
//   Write .tmp/auto.txt  ->  approval card: 「允许 Claude 写入 吗？」
//   card subtitle: 「ask mode prompts before edits and commands」   <- not auto
//
// Auto applies edits without asking (decide() answers prompt:false for ACTIONS.EDIT),
// so the card should never have appeared. Two places dropped the mode:
//   session-kernel -> createAgent({...}) did not pass permissionMode
//   main.cjs getAgent() cached ONE runner and called it with no arguments
//
// After the fix the same request answers without a card and the file is created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { decide, ACTIONS } = require(path.join(ROOT, 'desktop', 'permissions.cjs'));
const { actionFor } = require(path.join(ROOT, 'desktop', 'tool-approval.cjs'));

test('auto mode does not prompt for a write', () => {
  // The behaviour the user expects from 自动.
  assert.equal(decide('auto', actionFor('Write')).prompt, false);
  assert.equal(decide('auto', actionFor('Edit')).prompt, false);
});

test('auto mode still confirms a shell command', () => {
  // Auto is not a blanket bypass: an unattended command is the one thing a user
  // cannot undo, so it stays gated.
  assert.equal(decide('auto', actionFor('Bash')).prompt, true);
});

test('ask mode does prompt for a write', () => {
  // The contrast case, so the fix cannot be 'never prompt'.
  assert.equal(decide('ask', actionFor('Write')).prompt, true);
});

test('the kernel passes the session mode to the agent', () => {
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  assert.match(kernel, /permissionMode:\s*session\.permissionMode/, 'the createAgent call must forward the session mode');
});

test('the runner honours a per-run mode over the process config', () => {
  const config = fs.readFileSync(path.join(ROOT, 'desktop', 'agent-config.cjs'), 'utf8');
  assert.match(config, /async run\(\{[^}]*permissionMode[^}]*\}\)/, 'run() must accept the mode');
  assert.match(config, /VALID_MODES\.has\(permissionMode\)/, 'it must validate it');
  assert.match(config, /mode:\s*effectiveMode/, 'the executor must receive the resolved mode');
});

test('the agent cache is keyed by mode, not shared', () => {
  // A single cached runner would pin every session to the first mode used.
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /agentRunners\s*=\s*new Map\(\)/, 'runners must be cached per mode');
  assert.match(main, /createAgent:\s*\(opts\)\s*=>\s*getAgent\(\s*opts/, 'the injection point must forward the mode');
});