// The CCB child must spawn at start(), not at the first Send.
//
// This is the premise that decided whether the default kernel could be switched. The earlier
// note said "first frame ~2.7s, so the UI needs a kernel-starting state first" — which is only
// a problem if the spawn happens when the user presses Send. It does not: start() spawns
// eagerly, and the composer calls start() via prewarm while the user is still typing.
//
// Measured on this host: spawn -> handshake ~0.8s, and the child is alive and handshaken
// before the first sendMessage. So the latency is paid during typing, not after Send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCcbKernel } = require('../desktop/ccb-kernel.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

// A child that records its own spawn, so "spawned at start" is observable rather than inferred.
const FAKE = [
  'const fs = require("node:fs");',
  'const readline = require("node:readline");',
  'if (process.env.SPAWN_LOG) fs.appendFileSync(process.env.SPAWN_LOG, "spawn\\n");',
  'const out = (f) => process.stdout.write(JSON.stringify(f) + "\\n");',
  'out({ type: "system", subtype: "init", session_id: "fake", tools: [] });',
  'const rl = readline.createInterface({ input: process.stdin });',
  'rl.on("line", (line) => {',
  '  let f; try { f = JSON.parse(line); } catch { return; }',
  '  if (f.type === "control_request" && f.request.subtype === "initialize") {',
  '    out({ type: "control_response", response: { subtype: "success", request_id: f.request_id,',
  '      response: { commands: [], agents: [], models: [{ name: "m", value: "m" }], account: {}, output_style: "default", available_output_styles: [] } } });',
  '    return;',
  '  }',
  '  if (f.type === "user") {',
  '    out({ type: "result", subtype: "success", result: "ok", stop_reason: "end_turn", session_id: "fake" });',
  '  }',
  '});',
].join('\n');

function makeKernel() {
  const dir = mkdtempSync(path.join(tmpdir(), 'spawn-at-start-'));
  const entry = path.join(dir, 'cli-bun.js');
  writeFileSync(entry, FAKE);
  const spawnLog = path.join(dir, 'spawn.log');
  const kernel = createCcbKernel({
    bunPath: process.execPath,
    entryPath: entry,
    kernelRoot: dir,
    cwd: dir,
    env: { SPAWN_LOG: spawnLog },
    startupTimeoutMs: 8000,
    turnTimeoutMs: 8000,
  });
  return { kernel, spawnLog };
}

test('start() spawns the child before any turn is sent', async () => {
  const { kernel, spawnLog } = makeKernel();
  try {
    const session = createSessionKernel({ emit: () => {}, backend: kernel });
    session.start({ cwd: tmpdir() });
    // Give the spawn a moment; no sendMessage has been called yet.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !existsSync(spawnLog)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(spawnLog), true,
      'the child must be spawned by start(); otherwise the first Send pays the cost');
  } finally {
    await kernel.dispose();
  }
});

test('the child is handshaken (models known) before the first turn', async () => {
  const { kernel } = makeKernel();
  try {
    const session = createSessionKernel({ emit: () => {}, backend: kernel });
    const started = session.start({ cwd: tmpdir() });
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && kernel.listModels(started.sessionId).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(kernel.listModels(started.sessionId).length > 0,
      'the initialize handshake must complete during start(), while the user types');
  } finally {
    await kernel.dispose();
  }
});

test('spawning once is enough: a second start does not respawn', async () => {
  // Each spawn costs ~0.8s; respawning per session would multiply that.
  const { kernel, spawnLog } = makeKernel();
  try {
    const session = createSessionKernel({ emit: () => {}, backend: kernel });
    const a = session.start({ cwd: tmpdir() });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !existsSync(spawnLog)) await new Promise((r) => setTimeout(r, 25));
    const first = readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length;
    // A second start on the same session must not spawn again.
    session.start({ sessionId: a.sessionId, cwd: tmpdir() });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(after, first, 'the child must be reused, not respawned');
  } finally {
    await kernel.dispose();
  }
});
