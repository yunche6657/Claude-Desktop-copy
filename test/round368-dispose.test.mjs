import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createCcbKernel } = createRequire(import.meta.url)('../desktop/ccb-kernel.cjs');

test('dispose waits for removed but still live children and reports them until exit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccb-dispose-'));
  const script = path.join(dir, 'entry.cjs'); writeFileSync(script, '');
  const child = new EventEmitter(); child.pid = 424242;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let endCalled = false, kills = 0;
  child.stdin = new Writable({ write(chunk, enc, cb) {
    const frame = JSON.parse(chunk.toString());
    if (frame.type === 'control_request') queueMicrotask(() => child.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{models:[]}}})+'\n'));
    cb();
  }, final(cb) { endCalled = true; cb(); } });
  child.kill = () => { kills++; return true; };
  const kernel = createCcbKernel({ bunPath: process.execPath, entryPath: script, kernelRoot: dir, cwd: dir, platform: 'linux', disposeTimeoutMs: 40,
    spawnImpl() { queueMicrotask(() => child.emit('spawn')); return child; } });
  await kernel.warm('removed');
  assert.equal(kernel.removeSession('removed').ok, true);
  let complete = false;
  const disposing = kernel.dispose().then(value => { complete = true; return value; });
  assert.equal(kernel.getActiveProcesses().length, 1);
  assert.equal(endCalled, true);
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.ok(kills >= 2);
  assert.equal(kernel.getActiveProcesses().length, 1);
  child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(complete, false, 'exit must not finish disposal before pipe close');
  assert.equal(kernel.getActiveProcesses().length, 1);
  child.emit('close', 0, null);
  await disposing;
  assert.equal(complete, true);
  assert.deepEqual(kernel.getActiveProcesses(), []);
});

test('dispose rejects if a force-killed child never reports exit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccb-dispose-'));
  const script = path.join(dir, 'entry.cjs'); writeFileSync(script, '');
  const child = new EventEmitter(); child.pid = 424243; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({write(chunk, enc, cb) { const frame=JSON.parse(chunk.toString()); queueMicrotask(()=>child.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{models:[]}}})+'\n')); cb(); }});
  child.kill = () => true;
  const kernel = createCcbKernel({bunPath:process.execPath, entryPath:script, kernelRoot:dir, cwd:dir, platform:'linux', disposeTimeoutMs:20, spawnImpl(){queueMicrotask(()=>child.emit('spawn'));return child;}});
  await kernel.warm('a');
  await assert.rejects(kernel.dispose(), /did not exit/);
  assert.equal(kernel.getActiveProcesses().length, 1);
  const retry = kernel.dispose();
  assert.equal(kernel.dispose(), retry);
  child.emit('exit', 0, null); child.emit('close', 0, null);
  assert.equal((await retry).ok, true);
  assert.deepEqual(kernel.getActiveProcesses(), []);
});
