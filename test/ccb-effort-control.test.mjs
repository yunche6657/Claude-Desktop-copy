import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');

test('CCB applies session effort before user input, deduplicates acknowledged values and never changes permissions', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccb-effort-'));
  const script = path.join(dir, 'core.cjs');
  writeFileSync(script, String.raw`
const readline = require('node:readline'), fs = require('node:fs'), path = require('node:path');
let effort = 'unset';
const out = x => process.stdout.write(JSON.stringify(x) + '\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const f = JSON.parse(line);
  if (f.type === 'control_request') {
    if (f.request.subtype === 'apply_flag_settings') {
      if (Object.keys(f.request.settings).join(',') !== 'effortLevel') throw Error('permission settings changed');
      effort = f.request.settings.effortLevel;
      fs.appendFileSync(path.join(__dirname, 'controls.log'), effort + '\n');
      return setTimeout(() => out({type:'control_response',response:{subtype:'success',request_id:f.request_id}}), 10);
    }
    return out({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{}}});
  }
  if (f.type === 'user') out({type:'result',subtype:'success',result:effort});
});`);
  const kernel = createCcbKernel({bunPath:process.execPath, entryPath:script, kernelRoot:dir, cwd:dir, homeDir:path.join(dir,'home'), scratchDir:path.join(dir,'scratch')});
  t.after(() => kernel.dispose());
  assert.equal((await kernel.sendMessage('s', 'hi', {effortLevel:'low'})).text, 'low');
  assert.equal((await kernel.sendMessage('s', 'hi', {effortLevel:'high'})).text, 'high');
  assert.equal((await kernel.sendMessage('s', 'hi', {effortLevel:'high'})).text, 'high');
  assert.equal(readFileSync(path.join(dir,'controls.log'),'utf8'), 'low\nhigh\n');
  await assert.rejects(kernel.sendMessage('s', 'hi', {effortLevel:'invalid'}), /Invalid CCB effortLevel/);
});
