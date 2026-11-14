// The kernel's own capability inventory must survive the handshake.
//
// Measured: the initialize control_response carries `commands` (34 slash commands), `agents`
// (6 presets) and `models` (6 entries, each with supportsEffort / supportedEffortLevels /
// supportsFastMode / supportsAutoMode). The backend used to read the response and throw the
// body away, so the model picker had to invent a one-entry list. These tests pin that the
// inventory is kept and shaped, without a real kernel and without a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');

// A child that answers initialize with the shape measured from the real kernel (trimmed).
const FAKE = `
'use strict';
const readline = require('node:readline');
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'fake', tools: ['Bash'], model: 'claude-sonnet-4-6' });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.type !== 'control_request') return;
  if (!frame.request || frame.request.subtype !== 'initialize') return;
  out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {
    commands: [{ name: 'compact', description: 'Summarise', argumentHint: '' }, { name: 'review', description: 'Review', argumentHint: '' }],
    agents: [{ name: 'general-purpose', description: 'Default agent' }],
    models: [
      { name: 'default', value: 'default', displayName: 'Default (recommended)', description: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], supportsAutoMode: true },
      { name: 'opus', value: 'opus', displayName: 'Opus 4.7', description: 'Most capable', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true, supportsAutoMode: true },
      { name: 'haiku', value: 'haiku', displayName: 'Haiku', description: 'Fast' }
    ],
    account: { tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' },
    output_style: 'default',
    available_output_styles: ['default', 'Explanatory'],
    pid: 4242,
  } } });
});
`;

// A child that never answers initialize: the "handshake has not happened yet" case.
const SILENT = FAKE.replace(
  "  if (frame.type !== 'control_request') return;",
  '  if (frame.type !== \'never\') return;',
);

async function makeKernel({ answerInitialize = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'caps-'));
  const entry = path.join(dir, 'cli-bun.js');
  writeFileSync(entry, answerInitialize ? FAKE : SILENT);
  const kernel = createCcbKernel({ bunPath: process.execPath, entryPath: entry, kernelRoot: dir, startupTimeoutMs: 5000 });
  kernel.start({ sessionId: 's1' });
  // Give the handshake a moment to land.
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const info = kernel.getInfo('s1');
    if (info && info.init && Array.isArray(info.init.models) && info.init.models.length) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return kernel;
}

test('the handshake inventory is kept, not read and discarded', async () => {
  const kernel = await makeKernel();
  try {
    const info = kernel.getInfo('s1');
    assert.ok(info.init, 'the init payload must be retained');
    assert.equal(info.init.models.length, 3, 'every advertised model is kept');
    assert.equal(info.init.commands.length, 2, 'slash commands are kept too');
    assert.equal(info.init.agents[0].name, 'general-purpose');
    assert.equal(info.init.pid, 4242);
    assert.deepEqual(info.init.availableOutputStyles, ['default', 'Explanatory']);
  } finally {
    await kernel.dispose();
  }
});

test('listModels returns something a picker can render', async () => {
  const kernel = await makeKernel();
  try {
    const models = kernel.listModels('s1');
    assert.equal(models.length, 3);
    const opus = models.find((model) => model.id === 'opus');
    assert.equal(opus.name, 'Opus 4.7', 'the display name is what the user reads');
    assert.equal(opus.supportsEffort, true);
    assert.deepEqual(opus.effortLevels, ['low', 'high']);
    assert.equal(opus.supportsFastMode, true);
    // A model that advertises no effort support must not claim an empty level list as if it did.
    const haiku = models.find((model) => model.id === 'haiku');
    assert.equal(haiku.supportsEffort, false);
    assert.deepEqual(haiku.effortLevels, []);
  } finally {
    await kernel.dispose();
  }
});

test('before the handshake the model list is empty, not invented', async () => {
  // A picker showing one hard-coded model looks like data and is not. Empty is honest.
  const kernel = await makeKernel({ answerInitialize: false });
  try {
    assert.deepEqual(kernel.listModels('s1'), []);
  } finally {
    await kernel.dispose();
  }
});

test('a capabilities event fires so the UI can react without polling', async () => {
  const kernel = createCcbKernel({
    bunPath: process.execPath,
    entryPath: (() => { const dir = mkdtempSync(path.join(tmpdir(), 'caps2-')); const file = path.join(dir, 'cli-bun.js'); writeFileSync(file, FAKE); return file; })(),
    kernelRoot: tmpdir(),
    startupTimeoutMs: 5000,
  });
  const events = [];
  kernel.onEvent((event) => events.push(event));
  try {
    kernel.start({ sessionId: 's2' });
    const started = Date.now();
    while (Date.now() - started < 3000 && !events.some((event) => event.type === 'capabilities')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const caps = events.find((event) => event.type === 'capabilities');
    assert.ok(caps, 'the UI must not have to poll getInfo to learn the model list');
    assert.equal(caps.models.length, 3);
  } finally {
    await kernel.dispose();
  }
});
