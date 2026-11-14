// Tests for CcbKernel: claude-code-best as a child process over stream-json,
// behind the AgentKernelBackend contract.
//
// No network, no real kernel. A fake "bun" — a Node script that replays the
// frame shapes measured on the real kernel — stands in for the child process.
// The fake records what the host wrote to it, so the assertions can check both
// directions of the protocol.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const {
  createCcbKernel,
  resolveCcbPaths,
  defaultBunPath,
  defaultKernelRoot,
  defaultProjectRoot,
  referenceKernelRoot,
  flattenContent,
} = require('../desktop/ccb-kernel.cjs');
const { isKernelBackend } = require('../desktop/kernel-backend.cjs');
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

// A fake kernel. It speaks the measured protocol:
//   - answers the initialize control_request with the full response envelope
//   - emits system/init, assistant, and exactly one result frame per user frame
//   - handles interrupt by answering it and emitting result/error_during_execution
//   - can be told to crash or to stall, and logs the frames it receives so the
//     tests can assert what the host sent.
const FAKE_KERNEL = String.raw`
'use strict';
const readline = require('node:readline');
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const log = (entry) => {
  const file = process.env.FAKE_CCB_LOG;
  if (!file) return;
  require('node:fs').appendFileSync(file, JSON.stringify(entry) + '\n');
};
let seq = 0;
const id = (prefix) => prefix + '-' + (++seq);
let pendingSlow = null;

// Report the environment this process was actually started with, so a test can
// assert on what the backend handed the child rather than on what it meant to.
const reportPath = process.env.FAKE_CCB_ENV_OUT;
if (reportPath) {
  require('node:fs').writeFileSync(reportPath, JSON.stringify({
    TEMP: process.env.TEMP || null,
    TMP: process.env.TMP || null,
    TMPDIR: process.env.TMPDIR || null,
    PATH: process.env.PATH || null,
    Path: process.env.Path || null,
    MARKER: process.env.FAKE_CCB_MARKER || null,
    AUTH_TOKEN_PRESENT: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    HOME: process.env.HOME || null,
    USERPROFILE: process.env.USERPROFILE || null,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,
  }));
}

out({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model',
  cwd: process.cwd(), permissionMode: 'bypassPermissions', tools: ['Bash', 'Read'],
  claude_code_version: 'fake-1.0' });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  log(frame);
  if (frame.type === 'control_request') {
    const subtype = frame.request && frame.request.subtype;
    if (subtype === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
        response: { commands: [{ name: 'compact' }], agents: [], models: [],
          account: { tokenSource: 'none', apiProvider: 'firstParty' },
          output_style: 'default', available_output_styles: ['default'], pid: process.pid } } });
      return;
    }
    if (subtype === 'set_permission_mode' || subtype === 'apply_flag_settings' || subtype === 'set_model') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
      return;
    }
    if (subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
      const slow = pendingSlow;
      pendingSlow = null;
      if (slow) {
        out({ type: 'user', message: { role: 'user', content: [
          { type: 'tool_result', content: 'Exit code 126\n[Request interrupted by user for tool use]',
            is_error: true, tool_use_id: 'toolu_interrupted' }] },
          parent_tool_use_id: null, session_id: 'fake-session' });
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null,
          result: '', duration_ms: 5, session_id: 'fake-session' });
      }
      return;
    }
    return;
  }
  if (frame.type !== 'user') return;
  const text = frame.message.content.map((b) => b.text || '').join('');
  log({ received_user: text });

  if (text.includes('CRASH')) {
    // Die without a result frame: the host must not hang.
    process.exit(9);
    return;
  }
  if (text.includes('STALL')) {
    // Keep the event loop alive so ending stdin does not end the process: this
    // is the case dispose() has to force-kill.
    setInterval(() => {}, 1000);
    return;
  }
  if (text.includes('SLOW')) {
    pendingSlow = text;
    return;
  }
  if (text.includes('NONJSON')) {
    process.stdout.write('Warning: something printed to stdout that is not a frame\n');
  }
  if (text.includes('PERMISSION')) {
    // Ask the host whether a tool may run, then report what it answered.
    const toolUseId = id('toolu');
    out({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo HI' } }] },
      parent_tool_use_id: null, session_id: 'fake-session' });
    const requestId = id('perm');
    out({ type: 'control_request', request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo HI' },
        tool_use_id: toolUseId } });
    const onAnswer = (answerFrame) => {
      if (!answerFrame || answerFrame.type !== 'control_response') return;
      if (!answerFrame.response || answerFrame.response.request_id !== requestId) return;
      rl.removeListener('line', handleAnswer);
      const decision = answerFrame.response.response || {};
      log({ permission_answer: decision });
      const allowed = decision.behavior === 'allow';
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result',
        tool_use_id: toolUseId, content: allowed ? 'HI' : (decision.message || 'denied'),
        is_error: !allowed }] }, parent_tool_use_id: null, session_id: 'fake-session' });
      out({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: allowed ? 'RAN-ALLOWED' : 'RAN-DENIED' }] },
        parent_tool_use_id: null, session_id: 'fake-session' });
      out({ type: 'result', subtype: 'success', is_error: false,
        result: allowed ? 'RAN-ALLOWED' : 'RAN-DENIED', stop_reason: 'end_turn',
        session_id: 'fake-session' });
    };
    const handleAnswer = (answerLine) => {
      let answerFrame;
      try { answerFrame = JSON.parse(answerLine); } catch { return; }
      log(answerFrame);
      onAnswer(answerFrame);
    };
    rl.on('line', handleAnswer);
    return;
  }

  out({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'considering the question' }] },
    parent_tool_use_id: null, session_id: 'fake-session' });
  out({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'ECHO:' + text }] }, parent_tool_use_id: null, session_id: 'fake-session' });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ECHO:' + text,
    stop_reason: 'end_turn', duration_ms: 12, total_cost_usd: 0.001, session_id: 'fake-session' });
});
`;

/** Write the fake kernel to a temp dir and return the paths to point the backend at. */
function makeFakeKernel(logPath = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ccb-'));
  const entry = path.join(dir, 'cli-bun.js');
  writeFileSync(entry, FAKE_KERNEL);
  return {
    dir,
    entry,
    logPath,
    // node is the "bun" here: the backend only cares that it can spawn it and
    // that the entry script is the first argument.
    bunPath: process.execPath,
    options: {
      bunPath: process.execPath,
      entryPath: entry,
      kernelRoot: dir,
      env: logPath ? { FAKE_CCB_LOG: logPath } : {},
      turnTimeoutMs: 8000,
      interruptGraceMs: 1500,
      disposeTimeoutMs: 1500,
      startupTimeoutMs: 8000,
    },
  };
}

function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  const text = require('node:fs').readFileSync(logPath, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every kernel built here is registered, and afterEach disposes whatever the
// test did not.
//
// This is not tidiness. A child process inherits its pipes from us, so a child
// that is never disposed keeps OUR event loop alive and `node --test` never
// exits — the whole suite hangs on one failed test. Measured: a deliberately
// failing test that skipped dispose left both the test process and the fake
// kernel running indefinitely. Disposing from a hook that runs even on failure
// is what makes a red test reportable instead of fatal.
const active = new Set();
function makeKernel(options) {
  const kernel = createCcbKernel(options);
  active.add(kernel);
  return kernel;
}

afterEach(async () => {
  for (const kernel of [...active]) {
    try {
      await kernel.dispose();
    } catch { /* the host process is already going away */ }
    active.delete(kernel);
  }
});

test('real runtime profile snapshots capacity per actor and follows confirmed model switches', async t => {
  const { prepareCcbRuntime } = require('../desktop/ccb-runtime-config.cjs');
  const gateway = { baseUrl: 'https://gateway.invalid', apiKey: 'secret', apiType: 'anthropic', raw: {
    inferenceModels: [{ id: 'alpha', contextWindow: 10000 }, { id: 'beta', context_length: 20000 }],
  } };
  const runtime = await prepareCcbRuntime({ env: { ANTHROPIC_BASE_URL: gateway.baseUrl, ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CCB_GATEWAY_ADAPTER: 'system-first' }, gateway,
    startGateway: async () => ({ baseUrl: 'http://127.0.0.1:9999', stop: async () => {} }) });
  t.after(() => runtime.stop());
  const fake = makeFakeKernel();
  const kernel = makeKernel({ ...fake.options, env: runtime.env, model: 'alpha', contextWindows: runtime.contextWindows });
  await kernel.sendMessage('one', 'first', {});
  const first = kernel.getInfo('one');
  assert.deepEqual(first.contextCapacity, { actorToken: first.actorToken, model: 'alpha', contextWindow: 10000 });
  gateway.raw.inferenceModels[1].context_length = 30000;
  await kernel.setModel('one', 'beta');
  assert.deepEqual(kernel.getInfo('one').contextCapacity, { actorToken: first.actorToken, model: 'beta', contextWindow: 20000 });
  await kernel.setModel('one', 'unknown');
  assert.equal(kernel.getInfo('one').contextCapacity, undefined);
  await kernel.sendMessage('two', 'second', { model: 'beta' });
  const second = kernel.getInfo('two');
  assert.notEqual(second.actorToken, first.actorToken);
  assert.deepEqual(second.contextCapacity, { actorToken: second.actorToken, model: 'beta', contextWindow: 30000 });
  await kernel.sendMessage('other-gateway', 'third', { env: { ANTHROPIC_BASE_URL: 'https://other.invalid' } });
  assert.equal(kernel.getInfo('other-gateway').contextCapacity, undefined);
  assert.equal(JSON.stringify(second.contextCapacity).includes('secret'), false);
});

// --- construction and path resolution --------------------------------------

test('a missing bun executable is refused at construction, not mid-turn', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ccb-'));
  const entry = path.join(dir, 'cli-bun.js');
  writeFileSync(entry, '// entry');
  // The point of throwing here: the app can fall back to LocalKernel and say so.
  // A throw inside the first turn would look like a kernel crash instead.
  assert.throws(
    () => makeKernel({ bunPath: path.join(dir, 'nope.exe'), entryPath: entry, kernelRoot: dir }),
    /bun executable not found/,
  );
});

test('a missing entry script is refused at construction', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ccb-'));
  assert.throws(
    () => makeKernel({ bunPath: process.execPath, entryPath: path.join(dir, 'missing.js'), kernelRoot: dir }),
    /entry script not found/,
  );
});

test('environment variables select the bun binary, root and entry script', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ccb-'));
  const entry = path.join(dir, 'cli-bun.js');
  writeFileSync(entry, '// entry');
  const paths = resolveCcbPaths({
    env: { CCB_BUN: process.execPath, CCB_ROOT: dir, CCB_ENTRY: entry },
  });
  assert.equal(paths.bunPath, process.execPath);
  assert.equal(paths.kernelRoot, dir);
  assert.equal(paths.entryPath, entry);
});

test('the defaults are the bundled agent-core paths, not the %TEMP% reference checkout', () => {
  // The bundle ships with the app and is pinned by a manifest. %TEMP%\cc-best-ref
  // is where the protocol was first measured; it must not be a default, because a
  // reboot can clear it.
  const projectRoot = 'C:\\fake-repo';
  assert.equal(defaultBunPath(projectRoot), path.join(projectRoot, 'agent-core', 'bun', 'bun.exe'));
  assert.equal(defaultKernelRoot(projectRoot), path.join(projectRoot, 'agent-core', 'claude-code'));
  // The project root is derived from the module location, not from cwd: the app
  // must find its bundle however it was launched.
  assert.equal(defaultProjectRoot(), path.resolve(import.meta.dirname, '..'));
  // The reference checkout stays reachable for probes, but only when asked for.
  assert.equal(referenceKernelRoot('C:\\temp'), path.join('C:\\temp', 'cc-best-ref'));
});

test('the resolved defaults agree with desktop/kernel-select.cjs', () => {
  // Selection and spawning must look at the same two files, or the selector can
  // report "ccb available" and the spawn then fails.
  const { probeCcb } = require('../desktop/kernel-select.cjs');
  const projectRoot = defaultProjectRoot();
  const probe = probeCcb({ root: projectRoot, exists: () => true });
  const resolved = resolveCcbPaths({ env: {}, fsImpl: { existsSync: () => true }, projectRoot });
  assert.equal(resolved.bunPath, probe.bun);
  assert.equal(resolved.entryPath, probe.entry);
});

test('the bundled agent-core kernel is what this repository would actually spawn', () => {
  // Not a mock: assert against the real files in this checkout.
  const projectRoot = defaultProjectRoot();
  const paths = resolveCcbPaths({ env: {}, projectRoot });
  assert.equal(paths.bunPath, path.join(projectRoot, 'agent-core', 'bun', 'bun.exe'));
  assert.equal(paths.entryPath, path.join(projectRoot, 'agent-core', 'claude-code', 'dist', 'cli-bun.js'));
  assert.ok(existsSync(paths.bunPath), 'the bundled bun runtime must exist');
  assert.ok(existsSync(paths.entryPath), 'the bundled kernel entry must exist');
});

test('the backend satisfies the kernel contract', () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  assert.equal(kernel.id, 'ccb');
  assert.equal(isKernelBackend(kernel), true);
  return kernel.dispose();
});

// --- one turn --------------------------------------------------------------

test('one turn streams text and resolves with the result frame', async () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  const events = [];
  kernel.onEvent((event) => events.push(event));
  try {
    const result = await kernel.sendMessage('s1', 'hello', {});
    assert.equal(result.text, 'ECHO:hello');
    assert.equal(result.stopReason, 'end_turn');

    const texts = events.filter((e) => e.type === 'text').map((e) => e.text);
    assert.deepEqual(texts, ['ECHO:hello']);
    // The renderer's vocabulary, not stream-json's: `message` entries are built
    // by session-kernel, so the backend must not emit that name.
    assert.equal(events.some((e) => e.type === 'message'), false, 'the backend must not emit transcript rows');
    assert.equal(events.some((e) => e.type === 'turn_finished'), false, 'turn_finished belongs to session-kernel');
    // The full frames stay available for callers that want them.
    assert.ok(events.some((e) => e.type === 'raw' && e.frame.type === 'result'));
    assert.equal(kernel.getInfo('s1').init.model, 'fake-model');
    assert.deepEqual(kernel.getInfo('s1').init.tools, ['Bash', 'Read']);
  } finally {
    await kernel.dispose();
  }
});

test('the initialize handshake is sent before any user frame', async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), 'fake-ccb-')), 'frames.log');
  const fake = makeFakeKernel(logPath);
  const kernel = makeKernel(fake.options);
  try {
    await kernel.sendMessage('s1', 'hello', {});
    const frames = readLog(logPath);
    const initIndex = frames.findIndex((f) => f.type === 'control_request' && f.request?.subtype === 'initialize');
    const userIndex = frames.findIndex((f) => f.type === 'user');
    assert.ok(initIndex >= 0, 'an initialize request must be written');
    assert.ok(userIndex > initIndex, 'initialize must precede the user frame');
  } finally {
    await kernel.dispose();
  }
});

test('a non-JSON line on stdout does not break the turn', async () => {
  // The real kernel prints warnings to stdout; a strict parser would turn one
  // stray line into a failed turn.
  const fake = makeFakeKernel();
  const kernel = makeKernel({ ...fake.options, log: () => {} });
  try {
    const result = await kernel.sendMessage('s1', 'NONJSON hello', {});
    assert.equal(result.text, 'ECHO:NONJSON hello');
  } finally {
    await kernel.dispose();
  }
});

// --- multiple turns --------------------------------------------------------

test('a second turn reuses the same child process', async () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  try {
    const first = await kernel.sendMessage('s1', 'one', {});
    const pid = kernel.getInfo('s1').pid;
    assert.ok(pid > 0);
    const second = await kernel.sendMessage('s1', 'two', {});
    assert.equal(first.text, 'ECHO:one');
    assert.equal(second.text, 'ECHO:two');
    assert.equal(kernel.getInfo('s1').pid, pid, 'the process must be reused, not respawned');
  } finally {
    await kernel.dispose();
  }
});

test('two sessions get two processes', async () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  try {
    await kernel.sendMessage('s1', 'one', {});
    await kernel.sendMessage('s2', 'two', {});
    assert.notEqual(kernel.getInfo('s1').pid, kernel.getInfo('s2').pid,
      'one process per session: sharing would merge two conversations');
  } finally {
    await kernel.dispose();
  }
});

// --- interrupt -------------------------------------------------------------

test('cancel interrupts the running turn and the process survives it', async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), 'fake-ccb-')), 'frames.log');
  const fake = makeFakeKernel(logPath);
  const kernel = makeKernel(fake.options);
  try {
    const slow = kernel.sendMessage('s1', 'SLOW please', {});
    await wait(700); // let the frame reach the fake
    assert.equal(kernel.cancel('s1').ok, true);
    const result = await slow;
    assert.equal(result.stopReason, 'cancelled');
    // The interrupt must actually be sent: settling locally would leave the
    // child generating into the void and the next turn would race with it.
    const interrupts = readLog(logPath).filter((f) => f.type === 'control_request' && f.request?.subtype === 'interrupt');
    assert.equal(interrupts.length, 1, 'exactly one interrupt frame is written');
    // Idempotent: the session kernel calls cancel from several places.
    assert.equal(kernel.cancel('s1').ok, false);

    // Measured on the real kernel: after an interrupt the process answers the
    // next turn normally. If it did not, cancel would be a session killer.
    const next = await kernel.sendMessage('s1', 'after', {});
    assert.equal(next.text, 'ECHO:after');
  } finally {
    await kernel.dispose();
  }
});

test('cancel with no turn running answers ok:false instead of throwing', () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  assert.deepEqual(kernel.cancel('never-started'), { ok: false, reason: 'no running turn' });
  return kernel.dispose();
});

test('an aborted signal from the session kernel interrupts the turn', async () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  try {
    const controller = new AbortController();
    const slow = kernel.sendMessage('s1', 'SLOW via signal', { signal: controller.signal });
    await wait(700);
    controller.abort();
    const result = await slow;
    assert.equal(result.stopReason, 'cancelled');
  } finally {
    await kernel.dispose();
  }
});

// --- failure modes ---------------------------------------------------------

test('a kernel crash rejects the turn instead of hanging', async () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  const events = [];
  kernel.onEvent((event) => events.push(event));
  try {
    const started = Date.now();
    await assert.rejects(() => kernel.sendMessage('s1', 'CRASH now', {}), /exited/);
    assert.ok(Date.now() - started < 5000, 'the rejection must be prompt, not a timeout');
    assert.ok(events.some((e) => e.type === 'error' && /exited/.test(e.message)));
    // A dead process must not accept another turn silently.
    await assert.rejects(() => kernel.sendMessage('s1', 'again', {}), /exited|must be restarted/);
  } finally {
    await kernel.dispose();
  }
});

test('a turn that never reports times out instead of hanging forever', async () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel({ ...fake.options, turnTimeoutMs: 600 });
  try {
    await assert.rejects(() => kernel.sendMessage('s1', 'SLOW no interrupt', {}), /timed out/);
  } finally {
    await kernel.dispose();
  }
});

// --- permissions -----------------------------------------------------------

test('a can_use_tool request is answered with allow and the tool result follows', async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), 'fake-ccb-')), 'frames.log');
  const fake = makeFakeKernel(logPath);
  const asked = [];
  const kernel = makeKernel({
    ...fake.options,
    canUseTool: (request) => { asked.push(request); return 'allow'; },
  });
  try {
    const result = await kernel.sendMessage('s1', 'PERMISSION please', {});
    assert.equal(result.text, 'RAN-ALLOWED');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].toolName, 'Bash');
    assert.deepEqual(asked[0].input, { command: 'echo HI' });
    assert.match(asked[0].toolUseId, /^toolu-/);

    const answer = readLog(logPath).find((f) => f.permission_answer);
    assert.equal(answer.permission_answer.behavior, 'allow');
    assert.deepEqual(answer.permission_answer.updatedInput, { command: 'echo HI' });
  } finally {
    await kernel.dispose();
  }
});

test('a can_use_tool request is answered with deny when the hook says so', async () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel({ ...fake.options, canUseTool: () => 'deny' });
  try {
    const result = await kernel.sendMessage('s1', 'PERMISSION please', {});
    assert.equal(result.text, 'RAN-DENIED');
  } finally {
    await kernel.dispose();
  }
});

test('with no approval hook a tool request is denied rather than left hanging', async () => {
  // An unanswered control request stalls the kernel forever; the safe default
  // is an explicit deny.
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  try {
    const result = await kernel.sendMessage('s1', 'PERMISSION please', {});
    assert.equal(result.text, 'RAN-DENIED');
  } finally {
    await kernel.dispose();
  }
});

// --- environment -----------------------------------------------------------

test('the child gets a scratch TEMP and a real bash on PATH', async () => {
  // Measured failures this prevents (evidence/ccb-kernel-environment.md):
  //   ambient TEMP -> "EPERM: operation not permitted, mkdir ...\Temp\claude\..."
  //   ambient PATH -> "Exit code 126 [Request interrupted by user for tool use]"
  // Both read like tool bugs; both are environment.
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'fake-ccb-scratch-'));
  const envOut = path.join(mkdtempSync(path.join(tmpdir(), 'fake-ccb-')), 'env.json');
  const fake = makeFakeKernel();
  const kernel = makeKernel({
    ...fake.options,
    env: { FAKE_CCB_ENV_OUT: envOut },
    scratchDir,
    // Injected so the test does not depend on Git being installed: the point is
    // that the backend USES the resolved directory, not where it came from.
    kernelEnv: {
      platform: 'win32',
      exists: () => true,
      candidates: ['C:\\Program Files\\Git\\bin'],
    },
  });
  try {
    await kernel.sendMessage('s1', 'hello', {});
    const seen = JSON.parse(require('node:fs').readFileSync(envOut, 'utf8'));
    assert.equal(seen.TEMP, scratchDir, 'TEMP must point at the scratch directory');
    assert.equal(seen.TMP, scratchDir);
    assert.equal(seen.TMPDIR, scratchDir);
    assert.equal(seen.HOME, path.join(scratchDir, 'ccb-home'));
    assert.equal(seen.USERPROFILE, seen.HOME);
    assert.equal(seen.CLAUDE_CONFIG_DIR, seen.HOME);
    assert.ok(require('node:fs').statSync(seen.HOME).isDirectory());
    assert.match(seen.PATH, /^C:\\Program Files\\Git\\bin;/, 'git bin must be prepended to PATH');
    const info = kernel.getInfo('s1');
    assert.equal(info.env.applied.scratchDir, scratchDir);
    assert.equal(info.env.applied.bashDir, 'C:\\Program Files\\Git\\bin');
    assert.deepEqual(info.env.warnings, []);
  } finally {
    await kernel.dispose();
  }
});

test('a caller-supplied env is kept, not replaced, by the environment fix', async () => {
  // Silently dropping the caller's env would break provider credentials, which
  // arrive that way.
  const envOut = path.join(mkdtempSync(path.join(tmpdir(), 'fake-ccb-')), 'env.json');
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'fake-ccb-scratch-'));
  const fake = makeFakeKernel();
  const kernel = makeKernel({
    ...fake.options,
    env: { FAKE_CCB_ENV_OUT: envOut, FAKE_CCB_MARKER: 'KEPT', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ANTHROPIC_AUTH_TOKEN: 'synthetic-memory-only-token' },
    scratchDir,
    kernelEnv: { platform: 'win32', exists: () => true, candidates: ['C:\\git\\bin'] },
  });
  try {
    await kernel.sendMessage('s1', 'hello', {});
    const seen = JSON.parse(require('node:fs').readFileSync(envOut, 'utf8'));
    assert.equal(seen.MARKER, 'KEPT', 'the caller env survives');
    assert.equal(seen.AUTH_TOKEN_PRESENT, true);
    const savedSettings = JSON.parse(require('node:fs').readFileSync(path.join(scratchDir, 'kernel-settings-s1.json'), 'utf8'));
    assert.equal(savedSettings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234');
    assert.equal(savedSettings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(savedSettings.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(seen.TEMP, scratchDir, 'and the fix is still applied on top');
  } finally {
    await kernel.dispose();
  }
});

test('an unusable environment is reported instead of silently ignored', async () => {
  // No bash.exe anywhere: the kernel would fail every shell call with 126. The
  // caller has to be able to see that at start-up.
  const fake = makeFakeKernel();
  const kernel = makeKernel({
    ...fake.options,
    scratchDir: mkdtempSync(path.join(tmpdir(), 'fake-ccb-scratch-')),
    kernelEnv: { platform: 'win32', exists: () => false, candidates: ['C:\\nowhere'] },
  });
  try {
    await kernel.sendMessage('s1', 'hello', {});
    const info = kernel.getInfo('s1');
    assert.equal(info.env.applied.bashDir, null);
    assert.ok(
      info.env.warnings.some((w) => /no bash\.exe found/.test(w)),
      `the missing-bash warning must be reported, got ${JSON.stringify(info.env.warnings)}`,
    );
  } finally {
    await kernel.dispose();
  }
});

// --- lifecycle -------------------------------------------------------------

test('dispose ends the child process and refuses further work', async () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  await kernel.sendMessage('s1', 'one', {});
  const pid = kernel.getInfo('s1').pid;
  const closed = await kernel.dispose();
  assert.equal(closed.ok, true);
  const again = await kernel.dispose();
  assert.equal(again.alreadyDisposed, true);
  await assert.rejects(() => kernel.sendMessage('s1', 'two', {}), /disposed/);

  // No orphan: the process must be gone from the OS, not merely detached.
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the child process must be gone');
});

test('dispose force-kills a child that will not exit on its own', async () => {
  // Ending stdin is the polite path; a kernel stuck in a tool must still go.
  const fake = makeFakeKernel();
  const kernel = makeKernel({ ...fake.options, disposeTimeoutMs: 800 });
  const turn = kernel.sendMessage('s1', 'STALL please', {});
  const expectation = assert.rejects(() => turn, /disposed/);
  await wait(500);
  const pid = kernel.getInfo('s1').pid;
  const started = Date.now();
  await kernel.dispose();
  assert.ok(Date.now() - started < 4000, 'dispose must not wait forever');
  await expectation;
  await wait(300);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the stalled child must be killed');
});

test('dispose during a turn settles it instead of leaking a promise', async () => {
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  const slow = kernel.sendMessage('s1', 'SLOW during dispose', {});
  // Attach the rejection handler before disposing: dispose settles the promise
  // synchronously, and an unhandled rejection in between would be reported as a
  // warning rather than asserted on.
  const expectation = assert.rejects(() => slow, /disposed/);
  await wait(700);
  await kernel.dispose();
  await expectation;
});

// --- integration with session-kernel ---------------------------------------

test('the CCB backend drives a session kernel end to end', async () => {
  // The event vocabulary is the thing being checked: if CcbKernel emitted
  // stream-json names instead of agent.cjs names, this session would produce a
  // transcript with an empty assistant entry and no text_delta.
  const fake = makeFakeKernel();
  const kernel = makeKernel(fake.options);
  const events = [];
  const session = createSessionKernel({ emit: (e) => events.push(e), backend: kernel });
  try {
    const s = session.start({ cwd: fake.dir });
    const result = await session.sendMessage(s.sessionId, 'through the kernel');
    assert.equal(result.ok, true);
    assert.equal(result.text, 'ECHO:through the kernel');

    const transcript = session.getTranscript(s.sessionId);
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0].message.content[0].text, 'through the kernel');
    // The assistant row may carry several blocks: the kernel streams one frame per content
    // block (thinking first, then text), and the mapper merges them into ONE row — which is
    // what a real kernel does. Asserting on content[0] would pin the row to whichever block
    // happened to arrive first, so find the text block instead.
    const texts = transcript[1].message.content.filter((block) => block.type === 'text');
    assert.deepEqual(texts.map((block) => block.text), ['ECHO:through the kernel']);

    assert.ok(events.some((e) => e.type === 'text_delta' && e.text === 'ECHO:through the kernel'));
    assert.ok(events.some((e) => e.type === 'turn_finished'));
    assert.equal(session.getSession(s.sessionId).kernelBackend, 'ccb');
  } finally {
    await kernel.dispose();
  }
});

test('a tool call from the kernel becomes transcript rows', async () => {
  const fake = makeFakeKernel();
  // No construction-time canUseTool: the approval must travel the PRODUCTION path, which is
  // session-kernel's per-turn hook -> the renderer's card -> respondToToolPermission. Passing a
  // hook at construction would bypass that and test a shape the app never uses.
  const kernel = makeKernel(fake.options);
  const events = [];
  const session = createSessionKernel({ emit: (event) => events.push(event), backend: kernel });
  try {
    const s = session.start({ cwd: fake.dir });
    const pending = session.sendMessage(s.sessionId, 'PERMISSION please');
    // Answer the card the way the renderer does: wait for the request event, then respond.
    const request = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no tool_permission_request was emitted')), 5000);
      const poll = setInterval(() => {
        const found = events.find((event) => event.type === 'tool_permission_request');
        if (found) { clearInterval(poll); clearTimeout(timer); resolve(found.request); }
      }, 25);
    });
    assert.equal(request.requestId && typeof request.requestId, 'string', 'the card needs the id to answer with');
    assert.equal(request.toolName || request.tool_name, 'Bash', 'the card must name the tool');
    assert.equal(session.respondToApproval(request.requestId, 'allow').ok, true);
    const result = await pending;
    assert.equal(result.text, 'RAN-ALLOWED');
    const transcript = session.getTranscript(s.sessionId);
    // user, assistant(tool_use), user(tool_result), assistant(text)
    assert.equal(transcript.length, 4);
    assert.equal(transcript[1].message.content[0].type, 'tool_use');
    assert.equal(transcript[1].message.content[0].name, 'Bash');
    assert.equal(transcript[2].message.content[0].type, 'tool_result');
    assert.equal(transcript[2].message.content[0].tool_use_id, transcript[1].message.content[0].id);
    assert.equal(transcript[2].message.content[0].content, 'HI');
    assert.equal(transcript[3].message.content[0].text, 'RAN-ALLOWED');
  } finally {
    await kernel.dispose();
  }
});

// --- frame helpers ---------------------------------------------------------

test('flattenContent keeps every tool_result shape the kernel can send', () => {
  assert.equal(flattenContent('plain'), 'plain');
  assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(flattenContent([{ type: 'image' }]), '[image]');
  assert.equal(flattenContent({ text: 'inner' }), 'inner');
  assert.equal(flattenContent({ weird: 1 }), '{"weird":1}');
  assert.equal(flattenContent(null), '');
});

// This child models the *CLI persistence boundary*, not the backend's intended
// state: its context is loaded only when actual argv contains --resume. Capturing
// stdin alone would miss the defect where the renderer restored JSON but CCB saw
// only the next question in a brand-new process.
const PERSISTENT_FAKE = String.raw`
'use strict';
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const args = process.argv.slice(2);
const arg = flag => args[args.indexOf(flag) + 1];
const nativeId = args.includes('--resume') ? arg('--resume') : arg('--session-id');
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
const file = path.join(project, nativeId + '.jsonl');
fs.mkdirSync(project, { recursive: true });
const rows = args.includes('--resume') ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
fs.appendFileSync(process.env.FAKE_CCB_ARGV, JSON.stringify({ args, cwd: process.cwd(), home: process.env.CLAUDE_CONFIG_DIR, pid: process.pid }) + '\n');
const out = frame => process.stdout.write(JSON.stringify(frame) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { models: [] } } });
    return;
  }
  if (frame.type !== 'user') return;
  const text = frame.message.content.map(block => block.text || '').join('');
  const remembered = rows.find(row => row.type === 'user' && row.message.content[0].text.startsWith('Remember '));
  const result = text.startsWith('Remember ') ? 'ACK' : remembered?.message.content[0].text.slice(9) || 'LOST';
  const emittedId = process.env.FAKE_CCB_WRONG_ID || nativeId;
  out({ type: 'system', subtype: 'init', session_id: emittedId, cwd: process.cwd(), tools: [], model: 'fake' });
  rows.push({ type: 'user', sessionId: nativeId, cwd: process.cwd(), message: frame.message });
  rows.push({ type: 'assistant', sessionId: nativeId, cwd: process.cwd(), message: { role: 'assistant', content: [{ type: 'text', text: result }] } });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: result }] }, session_id: emittedId });
  out({ type: 'result', subtype: 'success', result, stop_reason: 'end_turn', session_id: emittedId });
});
`;

function persistentFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccb-persistent-'));
  const entry = path.join(dir, 'cli.cjs');
  const argvFile = path.join(dir, 'argv.jsonl');
  const storePath = path.join(dir, 'sessions.json');
  writeFileSync(entry, PERSISTENT_FAKE);
  const launch = (overrides = {}) => {
    const backend = makeKernel({ bunPath: process.execPath, entryPath: entry, kernelRoot: dir,
      cwd: dir, env: { FAKE_CCB_ARGV: argvFile }, turnTimeoutMs: 5000, ...overrides });
    const sessions = createSessionKernel({ backend, storePath, emit: () => {} });
    return { backend, sessions };
  };
  return { dir, storePath, argvFile, launch };
}

test('a persisted CCB session resumes its native UUID and context in a new child', async () => {
  const fixture = persistentFixture();
  const first = fixture.launch();
  const record = first.sessions.start({ cwd: fixture.dir });
  const id = record.sessionId;
  await first.sessions.sendMessage(id, 'Remember RESUME_SENTINEL');
  const sameChild = await first.sessions.sendMessage(id, 'Recall');
  assert.equal(sameChild.text, 'RESUME_SENTINEL');
  const saved = first.sessions.getSession(id);
  assert.equal(saved.cliSessionId, record.cliSessionId);
  assert.equal(saved.ccbResume.cliSessionId, saved.cliSessionId);
  assert.ok(existsSync(saved.ccbResume.transcriptPath));
  assert.equal(saved.ccbResume.cwd, fixture.dir);
  first.sessions.flush();
  first.sessions.dispose();
  await first.backend.dispose();
  const otherCwd = path.join(fixture.dir, 'different-host-default');
  mkdirSync(otherCwd);
  const restarted = fixture.launch({ cwd: otherCwd, homeDir: path.join(otherCwd, 'different-home') });
  assert.equal(restarted.sessions.getTranscript(id).length, 4);
  const resumed = await restarted.sessions.sendMessage(id, 'Recall');
  assert.equal(resumed.ok, true);
  assert.equal(resumed.text, 'RESUME_SENTINEL', 'restored JSON alone cannot provide the child with context');
  const launches = readLog(fixture.argvFile);
  assert.equal(launches.length, 2, 'same-process turns must not restart or resume a second time');
  assert.notEqual(launches[0].pid, launches[1].pid);
  assert.equal(launches[0].args.includes('--resume'), false);
  assert.equal(launches[0].args[launches[0].args.indexOf('--session-id') + 1], saved.cliSessionId);
  assert.equal(launches[1].args.includes('--session-id'), false);
  assert.equal(launches[1].args[launches[1].args.indexOf('--resume') + 1], saved.cliSessionId);
  assert.equal(launches[1].cwd, fixture.dir, 'resume must use the original cwd');
  assert.equal(launches[1].home, saved.ccbResume.homeDir, 'resume must use the original CLI home');
  restarted.sessions.dispose();
});

test('a missing native transcript fails restoration before spawning an empty conversation', async () => {
  const fixture = persistentFixture();
  const first = fixture.launch();
  const record = first.sessions.start({ cwd: fixture.dir });
  await first.sessions.sendMessage(record.sessionId, 'Remember MUST_NOT_LOSE');
  const saved = first.sessions.getSession(record.sessionId);
  first.sessions.flush();
  first.sessions.dispose();
  await first.backend.dispose();
  unlinkSync(saved.ccbResume.transcriptPath);
  const restarted = fixture.launch();
  const result = await restarted.sessions.sendMessage(record.sessionId, 'Recall');
  assert.equal(result.ok, false);
  assert.match(result.error || result.text || result.message || '', /no verified CLI transcript/);
  assert.equal(restarted.backend.getInfo(record.sessionId).pid, null);
  assert.equal(readLog(fixture.argvFile).length, 1);
  restarted.sessions.dispose();
});

test('a native log from a different cwd is not accepted just because the UUID matches', async () => {
  const fixture = persistentFixture();
  const first = fixture.launch();
  const record = first.sessions.start({ cwd: fixture.dir });
  await first.sessions.sendMessage(record.sessionId, 'Remember ORIGINAL');
  const saved = first.sessions.getSession(record.sessionId);
  first.sessions.flush();
  first.sessions.dispose();
  await first.backend.dispose();
  const lines = readFileSync(saved.ccbResume.transcriptPath, 'utf8').trim().split('\n').map(JSON.parse);
  for (const line of lines) line.cwd = path.join(fixture.dir, 'foreign');
  writeFileSync(saved.ccbResume.transcriptPath, lines.map(line => JSON.stringify(line)).join('\n'));
  const restarted = fixture.launch();
  const result = await restarted.sessions.sendMessage(record.sessionId, 'Recall');
  assert.equal(result.ok, false);
  assert.equal(restarted.backend.getInfo(record.sessionId).pid, null);
  restarted.sessions.dispose();
});

test('an unverified historical cliSessionId cannot silently start a fresh process on resume', async () => {
  const fixture = persistentFixture();
  const id = 'old-desktop-session';
  writeFileSync(fixture.storePath, JSON.stringify({ version: 2,
    sessions: [{ sessionId: id, cwd: fixture.dir, cliSessionId: 'not-a-native-uuid' }],
    transcripts: { [id]: [{ type: 'user', message: { role: 'user', content: 'past' } }] },
  }));
  const restored = fixture.launch();
  const result = await restored.sessions.sendMessage(id, 'Recall');
  assert.equal(result.ok, false);
  assert.match(result.error || result.text || result.message || '', /no valid native CLI session UUID/);
  assert.equal(restored.backend.getInfo(id).pid, null);
  restored.sessions.dispose();
});

test('old local history with a plausible random CLI UUID fails honestly instead of losing its context', async () => {
  const fixture = persistentFixture();
  const id = 'historical-local-session';
  writeFileSync(fixture.storePath, JSON.stringify({ version: 2,
    sessions: [{ sessionId: id, cwd: fixture.dir, kernelBackend: 'local', cliSessionId: require('node:crypto').randomUUID() }],
    transcripts: { [id]: [{ type: 'user', message: { role: 'user', content: 'LOCAL_HISTORY_MUST_SURVIVE' } },
      { type: 'assistant', message: { role: 'assistant', content: 'previous reply' } }] },
  }));
  const restored = fixture.launch();
  const result = await restored.sessions.sendMessage(id, 'Recall');
  assert.equal(result.ok, false);
  assert.match(result.error || result.text || result.message || '', /no verified CLI transcript/);
  assert.equal(restored.backend.getInfo(id).pid, null);
  assert.equal(existsSync(fixture.argvFile), false);
  assert.equal(restored.sessions.getTranscript(id)[0].message.content, 'LOCAL_HISTORY_MUST_SURVIVE');
  restored.sessions.dispose();
});

test('an empty historical session starts normally without trying to resume an absent transcript', async () => {
  const fixture = persistentFixture();
  const id = 'empty-historical-session';
  writeFileSync(fixture.storePath, JSON.stringify({ version: 2,
    sessions: [{ sessionId: id, cwd: fixture.dir, cliSessionId: require('node:crypto').randomUUID() }],
    transcripts: { [id]: [] },
  }));
  const restored = fixture.launch();
  const result = await restored.sessions.sendMessage(id, 'Remember NEW_EMPTY_SESSION');
  assert.equal(result.ok, true);
  const launch = readLog(fixture.argvFile)[0];
  assert.equal(launch.args.includes('--resume'), false);
  assert.equal(launch.args.includes('--session-id'), true);
  restored.sessions.dispose();
});

test('a different native init UUID is a protocol failure rather than successful context restoration', async () => {
  const fixture = persistentFixture();
  const { backend, sessions } = fixture.launch({ env: { FAKE_CCB_ARGV: fixture.argvFile,
    FAKE_CCB_WRONG_ID: '00000000-0000-4000-8000-000000000000' } });
  const record = sessions.start({ cwd: fixture.dir });
  const result = await sessions.sendMessage(record.sessionId, 'Remember ORIGINAL');
  assert.equal(result.ok, false);
  assert.match(result.error || result.text || result.message || '', /different CLI session UUID/);
  sessions.dispose();
});


test('image attachments reach the child stream-json frame without text flattening', async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), 'ccb-images-')), 'frames.jsonl');
  const fake = makeFakeKernel(logPath);
  const backend = makeKernel(fake.options);
  const image = { base64:'AAECAwQ=', mimeType:'image/png', filename:'fixture.png' };
  await backend.sendMessage('image-session', 'inspect fixture', { images:[image] });
  const frame = readLog(logPath).find(row => row.type === 'user');
  assert.deepEqual(frame.message.content, [
    { type:'text', text:'inspect fixture' },
    { type:'image', source:{type:'base64',media_type:'image/png',data:'AAECAwQ='} },
  ]);
});


test('the user UUID supplied by session-kernel reaches the actual child input frame',async()=>{
 const logPath=path.join(mkdtempSync(path.join(tmpdir(),'ccb-user-uuid-')),'frames.jsonl');const fake=makeFakeKernel(logPath);const backend=makeKernel(fake.options);const kernel=createSessionKernel({backend,emit:()=>{}});const s=kernel.start({cwd:fake.dir});const messageUuid='2da74a76-e769-400b-9acf-55b9d302c1f2';
 await kernel.sendMessage(s.sessionId,'correlate',{messageUuid});const frame=readLog(logPath).find(f=>f.type==='user');assert.equal(frame.uuid,messageUuid);assert.equal(kernel.getTranscript(s.sessionId)[0].uuid,messageUuid);assert.notEqual(kernel.getTranscript(s.sessionId)[1].uuid,messageUuid);
 await backend.sendMessage(s.sessionId,'fallback uuid',{messageUuid:'attachment-not-a-uuid'});
 const fallback=readLog(logPath).filter(f=>f.type==='user').at(-1);
 assert.match(fallback.uuid,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
 assert.notEqual(fallback.uuid,messageUuid);
});


test('governor process inventory counts real idle child PIDs and returns detached metadata', async () => {
  const fake = makeFakeKernel();
  const backend = makeKernel(fake.options);
  assert.deepEqual(backend.getActiveProcesses(), []);
  await backend.sendMessage('inventory-one', 'one', {});
  const first = backend.getActiveProcesses();
  assert.equal(first.length, 1);
  assert.equal(first[0].pid, backend.getInfo('inventory-one').pid);
  assert.equal(first[0].hasPendingTurn, false);
  first[0].pid = -1;
  assert.ok(backend.getActiveProcesses()[0].pid > 0);
  await backend.sendMessage('inventory-two', 'two', {});
  assert.equal(backend.getActiveProcesses().length, 2);
  await backend.dispose();
  assert.deepEqual(backend.getActiveProcesses(), []);
});
