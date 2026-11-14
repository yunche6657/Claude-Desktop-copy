// Tests for the Cowork VM service client and the startVM capability answer.
//
// The important finding these pin down: the frontend's secureVm gate depends on
// reaching the Cowork VM *service* (a Windows service listening on
// \\.\pipe\cowork-vm-service), not on the Windows Virtual Machine Platform
// optional feature. The packaged app installs that service; the VM bundle lives
// under userData/vm_bundles/claudevm.bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  PIPE_PATH,
  probeVmService,
  serviceBinaryPresent,
  bundlePresent,
  frameJson,
} = require('../desktop/cowork-vm-service.cjs');

test('the pipe path matches the shipped constant', () => {
  // Observed: lDn="\\\\.\\pipe\\cowork-vm-service"
  assert.equal(PIPE_PATH, '\\\\.\\pipe\\cowork-vm-service');
});

test('probing a pipe that does not exist answers unreachable, not a throw', async () => {
  const result = await probeVmService({ pipePath: '\\\\.\\pipe\\__definitely-not-a-pipe__', timeoutMs: 300 });
  assert.equal(result.reachable, false);
  assert.equal(typeof result.detail, 'string');
  assert.ok(result.detail.length > 0);
});

test('the probe reports the pipe it tried, so a failure is diagnosable', async () => {
  const result = await probeVmService({ pipePath: '\\\\.\\pipe\\__nope__', timeoutMs: 300 });
  assert.equal(result.pipePath, '\\\\.\\pipe\\__nope__');
});

test('serviceBinaryPresent is false for a directory without the binary', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'svc-'));
  assert.equal(serviceBinaryPresent(dir), false);
});

test('serviceBinaryPresent is true when cowork-svc.exe is there', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'svc-'));
  writeFileSync(path.join(dir, 'cowork-svc.exe'), 'stub');
  assert.equal(serviceBinaryPresent(dir), true);
});

test('bundlePresent requires rootfs.vhdx, not just the directory', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'ud-'));
  const bundle = path.join(userData, 'vm_bundles', 'claudevm.bundle');
  mkdirSync(bundle, { recursive: true });
  assert.equal(bundlePresent(userData).present, false);

  writeFileSync(path.join(bundle, 'rootfs.vhdx'), 'stub');
  const state = bundlePresent(userData);
  assert.equal(state.present, true);
  assert.equal(state.dir, bundle);
});

test('bundlePresent reports the adoption marker separately', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'ud-'));
  const bundle = path.join(userData, 'vm_bundles', 'claudevm.bundle');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(bundle, 'rootfs.vhdx'), 'stub');
  assert.equal(bundlePresent(userData).adopted, false);
  writeFileSync(path.join(bundle, '.cowork-adopted'), '');
  assert.equal(bundlePresent(userData).adopted, true);
});

test('frameJson prefixes the body with a 4-byte little-endian length', () => {
  const framed = frameJson({ hello: 'world' });
  const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
  assert.equal(framed.readUInt32LE(0), body.length);
  assert.equal(framed.subarray(4).toString('utf8'), body.toString('utf8'));
});
