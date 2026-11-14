import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { createDeploymentMode } = createRequire(import.meta.url)('../desktop/deployment-mode.cjs');

test('mode reads once, validates input, and writes before reset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-test-'));
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ deploymentMode: '1p', keep: true }));
    const observed = [];
    const mode = createDeploymentMode({ getConfigPath: () => file, resetWindowBounds: () => observed.push(JSON.parse(fs.readFileSync(file)).deploymentMode) });
    assert.equal(mode.get(), '1p');
    fs.writeFileSync(file, JSON.stringify({ deploymentMode: 'invalid', keep: true }));
    assert.equal(mode.get(), '1p');
    await mode.set('3p');
    assert.equal(mode.get(), '3p');
    assert.deepEqual(observed, ['3p']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { deploymentMode: '3p', keep: true });
    await mode.set('3p');
    await mode.set('1p', { skipWindowBoundsReset: true });
    assert.deepEqual(observed, ['3p']);
    await assert.rejects(mode.set('invalid'), /invalid deployment mode/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('read failures cache undefined; write failure leaves cache; reset errors are logged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-test-'));
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, '{broken');
    const logs = [];
    const mode = createDeploymentMode({ getConfigPath: () => file, resetWindowBounds: () => { throw Error('dummy reset'); }, log: message => logs.push(message) });
    assert.equal(mode.get(), undefined);
    await assert.rejects(mode.set('3p'));
    assert.equal(mode.get(), undefined);
    fs.writeFileSync(file, JSON.stringify({ deploymentMode: '1p' }));
    assert.equal(mode.get(), undefined);
    await mode.set('3p');
    assert.equal(mode.get(), '3p');
    assert.match(logs[0], /dummy reset/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('app config and persisted mode initialize independently and patch only disk changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-test-'));
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ deploymentMode: '1p' }));
    const mode = createDeploymentMode({ getConfigPath: () => file });
    assert.equal(mode.getAppConfigMode(), '1p');
    fs.writeFileSync(file, JSON.stringify({ deploymentMode: '3p' }));
    assert.equal(mode.get(), '3p');
    await mode.set('3p');
    assert.equal(mode.getAppConfigMode(), '1p');
    await mode.set('1p');
    await mode.set('3p');
    assert.equal(mode.getAppConfigMode(), '3p');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed mode commit preserves the original and removes its temporary copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-failure-'));
  const file = path.join(dir, 'config.json');
  const rename = fs.renameSync;
  try {
    fs.writeFileSync(file, JSON.stringify({ deploymentMode: '1p', unrelated: 'preserve' }));
    const before = fs.readFileSync(file);
    let resets = 0;
    const mode = createDeploymentMode({ getConfigPath: () => file, resetWindowBounds: () => { resets++; } });
    assert.equal(mode.get(), '1p');
    fs.renameSync = () => { throw new Error('fixture rename failure'); };
    await assert.rejects(mode.set('3p'), /fixture rename failure/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
    assert.equal(mode.get(), '1p');
    assert.equal(resets, 0);
    fs.renameSync = rename;
    await mode.set('3p');
    assert.equal(mode.get(), '3p');
    assert.equal(resets, 1);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
