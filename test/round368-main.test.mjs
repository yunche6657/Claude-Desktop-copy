import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Evaluate the actual main-process helper without starting Electron.
const source = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('function createGovernorVictimHandlers(');
const end = source.indexOf('\n/**\n * Decide, once,', start);
assert.ok(start >= 0 && end > start);
const createHandlers = vm.runInThisContext(`(${source.slice(start, end)})`);

function fixture() {
  const now = 200000;
  const process = { sessionId: 'a', pid: 11, actorToken: 'actor-a', protection: { version: 4 }, idleEligible: true, initialized: true };
  let current = process, eligible = true;
  const calls = [];
  const backend = { getActiveProcesses: () => current ? [current] : [],
    evictSession: async (id, expected) => { calls.push({ id, expected, valid: expected.validate() }); return { ok: calls.at(-1).valid }; } };
  const bridge = { pickLruIdleVictim: (processes) => eligible && processes.length && processes[0].idleEligible
    ? { sessionId: processes[0].sessionId, pid: processes[0].pid, actorToken: processes[0].actorToken,
        protectionVersion: processes[0].protection.version, lastUsedAt: 100000 } : null };
  const backends = new Set([backend]);
  const handlers = createHandlers({ backends, getBridge: () => bridge, now: () => now });
  return { handlers, backend, backends, calls, setCurrent: value => { current = value; }, setEligible: value => { eligible = value; } };
}

test('retains exact backend and rechecks the chosen process immediately before eviction', async () => {
  const f = fixture();
  const otherCalls = [];
  f.backends.add({ getActiveProcesses: () => [{ sessionId: 'a', pid: 99, actorToken: 'other', protection: { version: 4 }, idleEligible: true }], evictSession: () => otherCalls.push(true) });
  const victim = f.handlers.peekLruIdleVictim('pressure');
  assert.equal(victim.pid, 11);
  assert.deepEqual(Object.keys(victim).sort(), ['actorToken', 'idleSeconds', 'lastUsedAt', 'pid', 'protectionVersion', 'sessionId']);
  await f.handlers.evictVictim('a', { victim, purpose: 'pressure' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].valid, true);
  assert.equal(f.calls[0].expected.actorToken, 'actor-a');
  assert.deepEqual(otherCalls, []);
});

test('rejects changed actor, protection, visibility or pending eligibility at final check', async () => {
  for (const change of ['actor', 'version', 'eligibility']) {
    const f = fixture();
    const victim = f.handlers.peekLruIdleVictim('warm');
    if (change === 'actor') f.setCurrent({ sessionId: 'a', pid: 11, actorToken: 'new', protection: { version: 4 }, idleEligible: true });
    if (change === 'version') f.setCurrent({ sessionId: 'a', pid: 11, actorToken: 'actor-a', protection: { version: 5 }, idleEligible: true });
    if (change === 'eligibility') f.setEligible(false);
    await f.handlers.evictVictim('a', { victim, purpose: 'warm' });
    assert.equal(f.calls[0].valid, false, change);
  }
});

test('rejects wrong purpose, replay and duplicate backend identities', async () => {
  const f = fixture();
  const victim = f.handlers.peekLruIdleVictim('warm');
  f.handlers.evictVictim('a', { victim, purpose: 'pressure' });
  assert.equal(f.calls.length, 0);
  await f.handlers.evictVictim('a', { victim, purpose: 'warm' });
  f.handlers.evictVictim('a', { victim, purpose: 'warm' });
  assert.equal(f.calls.length, 1);
  f.backends.add({ getActiveProcesses: f.backend.getActiveProcesses });
  assert.equal(f.handlers.peekLruIdleVictim('warm'), null);
});

