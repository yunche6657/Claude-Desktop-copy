import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');
const { buildKernelEnv } = require('../desktop/kernel-env.cjs');

function fakeKernel(source, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-startup-fake-'));
  const entry = path.join(dir, 'kernel.cjs'); fs.writeFileSync(entry, source);
  return createCcbKernel({ bunPath: process.execPath, entryPath: entry, kernelRoot: dir,
    cwd: dir, homeDir: path.join(dir, 'home'), scratchDir: path.join(dir, 'scratch'),
    startupTimeoutMs: 2000, turnTimeoutMs: 2000, disposeTimeoutMs: 1000, ...options });
}

test('empty exit zero during turn rejects once with launch diagnostics and no retry', async t => {
  let spawns = 0;
  const kernel = fakeKernel('process.exit(0)', { spawnImpl: (...args) => { spawns++; return spawn(...args); } });
  t.after(() => kernel.dispose()); const errors = []; kernel.onEvent(e => { if (e.type === 'error') errors.push(e); });
  await assert.rejects(kernel.sendMessage('desktop-id', 'fixture'), error => {
    assert.equal(error.code, 'CCB_EMPTY_STARTUP_EXIT');
    assert.match(error.message, /stdout\/stderr both empty/);
    assert.equal(error.diagnostics.stdoutBytes, 0); assert.equal(error.diagnostics.stderrBytes, 0);
    assert.equal(error.diagnostics.stage, 'initialize');
    assert.match(error.diagnostics.cliSessionId, /^[0-9a-f-]{36}$/);
    return true;
  });
  assert.equal(spawns, 1); assert.equal(errors.length, 1);
});

test('eager empty exit is observable even without a turn', async t => {
  const kernel = fakeKernel('process.exit(0)'); t.after(() => kernel.dispose());
  const error = new Promise(resolve => kernel.onEvent(e => { if (e.type === 'error') resolve(e); }));
  kernel.start({ sessionId: 'eager' });
  const event = await error; assert.equal(event.code, 'CCB_EMPTY_STARTUP_EXIT');
  await assert.rejects(kernel.sendMessage('eager', 'fixture'), { code: 'CCB_EMPTY_STARTUP_EXIT' });
});

test('close drains final output before classifying an early exit', async t => {
  const kernel = fakeKernel("process.stdout.write('diagnostic\\n'); process.stderr.write('fixture-secret\\n'); process.exitCode = 0;");
  t.after(() => kernel.dispose());
  await assert.rejects(kernel.sendMessage('drain', 'fixture'), error => {
    assert.equal(error.code, 'CCB_PROCESS_EXIT');
    assert.ok(error.diagnostics.stdoutBytes > 0); assert.ok(error.diagnostics.stderrBytes > 0);
    assert.ok(!JSON.stringify(error.diagnostics).includes('fixture-secret')); return true;
  });
});

test('initialized idle exit zero is not an empty startup failure', async t => {
  let child;
  const kernel = fakeKernel(`const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.once('line', line => { const f = JSON.parse(line);
      process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{models:[]}}})+'\\n', () => process.exit(0));
    });`, { spawnImpl: (...args) => { child = spawn(...args); return child; } });
  t.after(() => kernel.dispose()); const errors = [];
  kernel.onEvent(e => { if (e.type === 'error') errors.push(e); });
  kernel.start({ sessionId: 'idle' });
  // start() schedules admission asynchronously, so wait for its observable child.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => child.once('close', resolve));
  assert.equal(errors.length, 0);
});

// Opt in: isolated initialize only; no user frame, provider request or user state.
test('real CCB isolated repeated initialize matrix', { skip: process.env.CCB_STARTUP_REAL !== '1', timeout: 180000 }, async t => {
  const core = process.env.CCB_REAL_CORE || 'D:/CodexArtifacts/ClawdPackageV021/app/release/win-unpacked/resources/agent-core';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-startup-real-'));
  async function probe(label, { entry = 'cli-bun.js', inherited = false, invalid = false, shared = false } = {}) {
    const dir = path.join(root, shared ? 'shared' : label); fs.mkdirSync(dir, { recursive: true });
    const base = { ...process.env };
    // Presence-only metadata is reported; no environment values or raw child output.
    if (!inherited) for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete base[key];
    const env = buildKernelEnv({ base, homeDir: path.join(dir, 'home'), scratchDir: path.join(dir, 'scratch') }).env;
    const uuid = invalid ? 'not-a-uuid' : randomUUID();
    const entryPath = path.join(core, 'claude-code/dist', entry);
    const args = [entryPath, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--session-id', uuid, '--strict-mcp-config'];
    const child = spawn(path.join(core, 'bun/bun.exe'), args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdoutBytes = 0, stderrBytes = 0, text = '', handshake = false, timedOut = false;
    const started = Date.now();
    child.stdin.on('error', () => {});
    child.stdout.on('data', c => { stdoutBytes += c.length; text += c.toString(); if (text.includes('control_response')) { handshake = true; child.stdin.end(); } });
    child.stderr.on('data', c => { stderrBytes += c.length; });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'startup-probe', request: { subtype: 'initialize' } }) + '\n');
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); clearTimeout(timer);
    const record = { label, entry, cwd: dir, uuid, uuidV4: /^[0-9a-f-]{14}4[0-9a-f-]{3}-[89ab]/i.test(uuid), inherited, shared, nodeOptionsPresent: !!env.NODE_OPTIONS, nodeTestContextPresent: !!env.NODE_TEST_CONTEXT, stdoutBytes, stderrBytes, handshake, timedOut, ...exit, elapsedMs: Date.now() - started };
    t.diagnostic(JSON.stringify(record)); return record;
  }
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push(await probe('repeat-' + i));
  rows.push(await probe('direct-entry', { entry: 'cli.js' }));
  rows.push(await probe('inherited-env', { inherited: true }));
  rows.push(await probe('invalid-uuid', { invalid: true }));
  rows.push(...await Promise.all([probe('parallel-a', { shared: true }), probe('parallel-b', { shared: true })]));
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(rows, null, 2));
  t.diagnostic('results=' + path.join(root, 'results.json'));
  assert.ok(rows.filter(r => r.label !== 'invalid-uuid').every(r => r.handshake), 'valid CCB starts must initialize; inspect recorded exit/byte counts');
  const invalid = rows.find(r => r.label === 'invalid-uuid');
  assert.equal(invalid.handshake, false); assert.notEqual(invalid.code, 0);
  assert.ok(invalid.stderrBytes > 0, 'invalid UUID must produce an explicit CLI diagnostic');
});
