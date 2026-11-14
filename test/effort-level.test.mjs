// The effort picker must reach the agent — the third dropped-parameter bug in this chain.
//
// FOUND by applying the previous round's own lesson ('ask whether the same function drops other
// parameters too'). The kernel passed four values to createAgent:
//
//   requestApproval, permissionMode, effortLevel, model
//
// but turnOptions carried only messages / signal / requestApproval / onEvent. agent-config's run()
// reads effortLevel from TURNOPTIONS, not from the factory options, so:
//
//   run({ ..., effortLevel })   <- always undefined
//     -> apiRequest({ effort: effortLevel })   <- always undefined
//
// MEASURED BEFORE: session.effortLevel was 'medium' but run() received undefined, so the level
// only changed a label. AFTER:
//
//   session effortLevel at start   medium
//   run() received                 'medium'
//   after update to 'high'         'high'
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const capabilities = require('../desktop/model-capabilities.cjs');
const originalProfile = capabilities.currentCapabilityProfile;
beforeEach(() => { capabilities.currentCapabilityProfile = () => ({
  inferenceModelCapabilities: { fixture: { supportedEfforts: ['medium', 'high'] } },
}); });
afterEach(() => { capabilities.currentCapabilityProfile = originalProfile; });

/** A kernel whose agent records the effort level of every turn. */
async function effortProbe() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-effort-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const seen = [];
  const kernel = createSessionKernel({
    createAgent: () => ({
      model: 'm',
      tools: [],
      run: async (opts) => { seen.push(opts.effortLevel); return { text: 'ok', stopReason: 'end_turn' }; },
    }),
    emit: () => {},
    storePath,
  });
  return { kernel, storePath, seen };
}

test('the effort level on the session reaches the agent', async () => {
  const p = await effortProbe();
  try {
    const s = p.kernel.start({ cwd: ROOT, model: 'fixture', effortLevel: 'medium' });
    assert.equal(typeof s.effortLevel, 'string', 'a new session has no effort level');
    await p.kernel.sendMessage(s.sessionId, 'hi');
    assert.equal(p.seen[0], s.effortLevel, 'the agent received a different effort level than the session holds');
    assert.notEqual(p.seen[0], undefined, 'the agent received no effort level at all');
  } finally {
    try { fs.unlinkSync(p.storePath); } catch { /* already gone */ }
  }
});

test('changing the effort level affects the next turn', async () => {
  const p = await effortProbe();
  try {
    const s = p.kernel.start({ cwd: ROOT, model: 'fixture', effortLevel: 'medium' });
    await p.kernel.sendMessage(s.sessionId, 'first');
    p.kernel.update(s.sessionId, { effortLevel: 'high' });
    await p.kernel.sendMessage(s.sessionId, 'second');
    assert.equal(p.seen[1], 'high', 'the updated effort level did not reach the agent');
    assert.notEqual(p.seen[0], p.seen[1], 'the level never changed between turns');
  } finally {
    try { fs.unlinkSync(p.storePath); } catch { /* already gone */ }
  }
});

test('turnOptions carries the effort level', () => {
  // The one-line cause: the object simply did not include it.
  const kernel = fs.readFileSync(path.join(ROOT, 'desktop', 'session-kernel.cjs'), 'utf8');
  const start = kernel.indexOf('const turnOptions = {');
  const end = kernel.indexOf('};', start);
  assert.ok(start > 0 && end > start, 'turnOptions is missing');
  assert.match(kernel.slice(start, end), /effortLevel: selectedEffort\(session\.model, session\.effortLevel\),/, 'turnOptions does not carry the effort level');
});

test('agent-config still maps effortLevel to the request effort', () => {
  // If this mapping disappears, forwarding the value would be pointless.
  const cfg = fs.readFileSync(path.join(ROOT, 'desktop', 'agent-config.cjs'), 'utf8');
  assert.match(cfg, /effort: effortLevel,/, 'the effort mapping is gone');
});
