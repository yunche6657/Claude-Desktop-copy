// A new session must start on the model the process is actually configured to use.
//
// FOUND BROKEN, live. Starting a session and sending one message answered:
//
//   { ok: false, error: 'API 503: No available channel for model claude-sonnet-5-5 ...' }
//
// even though resolveConfig() was returning 'deepseek-v4.1-flash' for the same process. The
// kernel had its own hard-coded default:
//
//   model: info.model || 'claude-sonnet-5-5',
//
// and tools/launch-replica.cjs already sets CLAUDE_AGENT_MODEL from the resolved profile — the
// kernel simply never read it. Every brand-new session therefore failed its first send, which is
// the most visible failure the app can have.
//
// MEASURED AFTER the fix:
//   model: 'deepseek-v4.1-flash'
//   sendMessage -> { ok: true }, transcript 2 rows, assistant text 'LIVECHECK'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function kernelWith(storePath) {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  return createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
}

function tmpStore() {
  return path.join(os.tmpdir(), 'dsh-model-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
}

test('a new session takes its model from CLAUDE_AGENT_MODEL', () => {
  const storePath = tmpStore();
  const saved = process.env.CLAUDE_AGENT_MODEL;
  try {
    process.env.CLAUDE_AGENT_MODEL = 'gateway-model-xyz';
    const s = kernelWith(storePath).start({ cwd: ROOT });
    assert.equal(s.model, 'gateway-model-xyz', 'the session ignored the configured model');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_AGENT_MODEL; else process.env.CLAUDE_AGENT_MODEL = saved;
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('ANTHROPIC_MODEL is used when CLAUDE_AGENT_MODEL is unset', () => {
  const storePath = tmpStore();
  const savedAgent = process.env.CLAUDE_AGENT_MODEL;
  const savedAnthropic = process.env.ANTHROPIC_MODEL;
  try {
    delete process.env.CLAUDE_AGENT_MODEL;
    process.env.ANTHROPIC_MODEL = 'anthropic-model-abc';
    const s = kernelWith(storePath).start({ cwd: ROOT });
    assert.equal(s.model, 'anthropic-model-abc');
  } finally {
    if (savedAgent !== undefined) process.env.CLAUDE_AGENT_MODEL = savedAgent;
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = savedAnthropic;
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('an explicit model on the session still wins', () => {
  const storePath = tmpStore();
  try {
    const s = kernelWith(storePath).start({ cwd: ROOT, model: 'explicit-model' });
    assert.equal(s.model, 'explicit-model', 'the caller-supplied model was overridden by the default');
  } finally {
    try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  }
});

test('the kernel no longer hard-codes the model as its only default', () => {
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  assert.match(kernel, /model: info\.model \|\| defaultSessionModel\(\),/, 'the session model default reverted to a literal');
  assert.match(kernel, /process\.env\.CLAUDE_AGENT_MODEL/, 'the kernel stopped reading the configured model');
});
