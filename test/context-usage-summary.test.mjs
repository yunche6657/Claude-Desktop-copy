// The composer's context meter reads getContextUsageSummary, which had no handler.
//
// FOUND by ranking the 86 called readers that still answer through the generic fallback and
// taking the ones a user sees. This one drives the context meter above the composer:
//
//   h.getContextUsageSummary(e).then(n => {
//     if (!n || !(n.rawMaxTokens > 0)) { settledEmpty; return }   // <- the gate
//     ...store(n)
//   })
//
// With no handler the answer was the generic null, so `!n` made EVERY session settle as empty
// and the meter never showed a number — even though getContextUsage (the sibling channel) was
// fully implemented and returns exactly the shape needed.
//
// The two channels now share one implementation. There is no reason for them to differ: the
// consumer of the summary only reads rawMaxTokens and the rest of the object is the same data
// the meter already renders elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function makeBridge() {
  const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));
  const { registerBridgeServices } = require(path.join(ROOT, 'desktop', 'bridge-services.cjs'));
  const storePath = path.join(os.tmpdir(), 'dsh-ctx-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
    storePath,
  });
  const handlers = new Map();
  registerBridgeServices({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    bridgeMap: require(path.join(ROOT, 'desktop', 'shim', 'bridge-map.json')),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: ROOT },
  });
  const call = async (service, method, ...args) => {
    const channel = [...handlers.keys()].find((c) => {
      const seg = c.split('_$_');
      return seg[seg.length - 2] === service && seg[seg.length - 1] === method;
    });
    if (!channel) throw new Error('no handler for ' + service + '.' + method);
    return await handlers.get(channel)({}, ...args);
  };
  return {
    call, kernel,
    cleanup: () => { try { fs.unlinkSync(storePath); } catch { /* gone */ } },
  };
}

test('missing observations remain unknown instead of guessed', async () => {
  const b = await makeBridge();
  try {
    const session = b.kernel.start({ cwd: os.tmpdir() });
    const summary = await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId);
    assert.equal(summary.totalTokens, null);
    assert.equal(summary.usageSource, 'unknown');
    assert.equal(summary.knownTokens, null);
    assert.equal(summary.rawMaxTokens, null);
    assert.equal(summary.maxTokensSource, 'unknown');
    assert.deepEqual(summary.mcpTools, []);
    assert.deepEqual(summary.memoryFiles, []);
    assert.deepEqual(summary.agents, []);
    // The shipped c2d611398 inspector calls .length/.map without optional guards.
    assert.doesNotThrow(() => [summary.mcpTools, summary.memoryFiles, summary.agents].map(rows => rows.length ? rows.map(row => row.tokens) : []));
  } finally { b.cleanup(); }
});

test('671 tokens in a configured 200k window rounds to zero percent, not zero tokens', async () => {
  const b = await makeBridge();
  try {
    const session = b.kernel.start({ cwd: os.tmpdir() });
    b.kernel.getContextUsage = () => ({ model: 'fixture', contextWindow: 200000, usage: {
      input_tokens: 671, output_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    } });
    const summary = await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId);
    assert.equal(summary.totalTokens, 671);
    assert.equal(summary.percentage, 0);
    assert.equal(summary.categories[0].tokens, 671);
    assert.equal(summary.rawMaxTokens, 200000);
    assert.equal(summary.maxTokensSource, 'configured_model_contextWindow');
  } finally { b.cleanup(); }
});

test('the two context channels answer exactly the same shape', async () => {
  // One implementation behind both; a divergence here means someone split them again.
  const b = await makeBridge();
  try {
    const session = b.kernel.start({ cwd: os.tmpdir() });
    const summary = await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId);
    const usage = await b.call('LocalSessions', 'getContextUsage', session.sessionId);
    assert.deepEqual(Object.keys(summary).sort(), Object.keys(usage).sort());
    assert.equal(summary.rawMaxTokens, usage.rawMaxTokens);
    assert.equal(summary.sessionId, usage.sessionId);
  } finally { b.cleanup(); }
});

test('summary never calls SDK and details expose estimated classified data', async () => {
  const b = await makeBridge();
  try {
    const session = b.kernel.start({ cwd: os.tmpdir() });
    let calls = 0;
    b.kernel.getContextUsageDetail = async () => { calls++; return {
      actorToken: 'secret', rawMaxTokens: 200000, totalTokens: 120, percentage: 0.06,
      categories: [{ name: 'System prompt', tokens: 20, color: 'permission' }, { name: 'Messages', tokens: 100 }, { name: 'private-name', tokens: 1 }],
      mcpTools: [{ name: 'read', serverName: 'fixture', tokens: 8, input: 'PRIVATE_CONTENT', actorToken: 'secret' }, null, { name: 'bad', serverName: 'fixture', tokens: -1 }],
      memoryFiles: [{ path: 'CLAUDE.md', tokens: 12, content: 'PRIVATE_CONTENT' }, { path: null, tokens: 1 }],
      agents: [{ agentType: 'reviewer', tokens: 6, prompt: 'PRIVATE_CONTENT' }, { agentType: 'bad', tokens: NaN }],
    }; };
    for (let i = 0; i < 5; i++) await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId);
    assert.equal(calls, 0);
    const detail = await b.call('LocalSessions', 'getContextUsage', session.sessionId);
    assert.equal(calls, 1);
    assert.equal(detail.estimated, true);
    assert.equal(detail.maxTokensSource, 'sdk_context_window_estimate');
    assert.deepEqual(detail.categories.map(x => x.name), ['System prompt', 'Messages', 'Other']);
    assert.equal('actorToken' in detail, false);
    assert.deepEqual(detail.mcpTools, [{ name: 'read', serverName: 'fixture', tokens: 8 }]);
    assert.deepEqual(detail.memoryFiles, [{ path: 'CLAUDE.md', tokens: 12 }]);
    assert.deepEqual(detail.agents, [{ agentType: 'reviewer', tokens: 6 }]);
    assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_CONTENT|secret/);
    b.kernel.getContextUsageDetail = async () => ({ rawMaxTokens: 100, totalTokens: 4, categories: [], mcpTools: null, memoryFiles: {}, agents: 'bad' });
    const absent = await b.call('LocalSessions', 'getContextUsage', session.sessionId);
    assert.deepEqual([absent.mcpTools, absent.memoryFiles, absent.agents], [[], [], []]);
    b.kernel.getContextUsageDetail = async () => ({ rawMaxTokens: NaN, totalTokens: 1, categories: [] });
    assert.equal((await b.call('LocalSessions', 'getContextUsage', session.sessionId)).detail, 'summary');
  } finally { b.cleanup(); }
});

test('a pending or failed SDK request keeps the summary inspector shape usable', async () => {
  const b = await makeBridge();
  try {
    const session = b.kernel.start({ cwd: os.tmpdir() });
    let resolve;
    b.kernel.getContextUsageDetail = () => new Promise(r => { resolve = r; });
    const pending = b.call('LocalSessions', 'getContextUsage', session.sessionId);
    const summary = await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId);
    assert.deepEqual([summary.mcpTools, summary.memoryFiles, summary.agents], [[], [], []]);
    assert.equal(summary.totalTokens, null);
    resolve(null);
    const loaded = await pending;
    assert.deepEqual(loaded, summary);
    b.kernel.getContextUsageDetail = async () => { throw new Error('private SDK failure'); };
    assert.deepEqual(await b.call('LocalSessions', 'getContextUsage', session.sessionId), summary);
  } finally { b.cleanup(); }
});

test('shipped context inspector accepts bridge summary and SDK detail without the recorded length crash', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'resources/ion-dist/assets/v1/c2d611398-Y2NVtf8_.js'), 'utf8');
  const match = source.match(/function ce\(e,t,n,r,i\)\{([\s\S]*?)\}var le=/);
  assert.ok(match, 'pinned inspector consumer must be present');
  const inspector = new Function('G', 'K', `return function(e,t,n,r,i){${match[1]}}`)(row => row.name, (_intl, row) => row.name);
  const intl = { formatMessage: value => value.defaultMessage };
  const b = await makeBridge();
  try {
    const session = b.kernel.start({ cwd: os.tmpdir() });
    assert.deepEqual(inspector(await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId), intl), []);
    b.kernel.getContextUsageDetail = async () => ({ rawMaxTokens: 1000, totalTokens: 12, categories: [],
      mcpTools: [{ name: 'Read', serverName: 'fixture', tokens: 3 }], memoryFiles: [{ path: 'CLAUDE.md', tokens: 4 }], agents: [{ agentType: 'reviewer', tokens: 5 }] });
    const sections = inspector(await b.call('LocalSessions', 'getContextUsage', session.sessionId), intl);
    assert.deepEqual(sections.map(row => row.key), ['mcp', 'memory', 'agents']);
    assert.deepEqual(sections.map(row => row.rows[0].tokens), [3, 4, 5]);
  } finally { b.cleanup(); }
});

test('an unknown session answers null for both channels', async () => {
  // The consumer treats !n as 'nothing to show', which is right for a missing session.
  const b = await makeBridge();
  try {
    assert.equal(await b.call('LocalSessions', 'getContextUsageSummary', 'local_not-real'), null);
    assert.equal(await b.call('LocalSessions', 'getContextUsage', 'local_not-real'), null);
  } finally { b.cleanup(); }
});

test('summary uses only the completed request capacity snapshot', async () => {
  const b = await makeBridge();
  try {
    const session = b.kernel.start({ cwd: os.tmpdir(), model: 'fixture' });
    b.kernel.getContextUsage = () => ({ model: 'fixture', contextWindow: 1000, usage: {
      input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    } });
    const summary = await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId);
    assert.equal(summary.rawMaxTokens, 1000);
    assert.equal(summary.percentage, 10);
    b.kernel.getContextUsage = () => ({ model: 'fixture', usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    assert.equal((await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId)).rawMaxTokens, null);
  } finally { b.cleanup(); }
});

test('context counts request input and cache once, excludes output and keeps missing cache unknown', async () => {
  const b = await makeBridge();
  try {
    const session = b.kernel.start({ cwd: os.tmpdir() });
    b.kernel.getContextUsage = () => ({ model: 'fixture', messageId: 'm1', usage: {
      input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 50, cache_creation_input_tokens: 10,
    } });
    const summary = await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId);
    assert.equal(summary.totalTokens, 80);
    assert.equal(summary.usageSource, 'completed_api_message');
    b.kernel.getContextUsage = () => ({ model: 'fixture', contextWindow: 1000, usage: {
      input_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10,
    } });
    const withoutOutput = await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId);
    assert.equal(withoutOutput.totalTokens, 80);
    assert.equal(withoutOutput.percentage, 8);
    assert.deepEqual(withoutOutput.missingFields, []);
    b.kernel.getContextUsage = () => ({ model: 'fixture', usage: { input_tokens: 20, output_tokens: 4 } });
    const partial = await b.call('LocalSessions', 'getContextUsageSummary', session.sessionId);
    assert.equal(partial.totalTokens, null);
    assert.equal(partial.knownTokens, 20);
    assert.deepEqual(partial.missingFields, ['cache_read_input_tokens', 'cache_creation_input_tokens']);
  } finally { b.cleanup(); }
});
