// R406: §1 remainder — Monitor.timeout_ms implemented, Agent.effort implemented,
//       RemoteTrigger's extra actions deliberately NOT implemented (no endpoint contract).
//
// THREE DIFFERENT VERDICTS IN ONE ROUND
//   Monitor.timeout_ms   -> implementable: a deadline the tool can own with setTimeout + killTask.
//   Agent.effort         -> implementable: CCB already has the whole effort pipeline
//                           (src/utils/effort.ts, appState.effortValue -> query -> outputConfig).
//   RemoteTrigger        -> NOT implementable: the three missing actions
//                           (create_webhook_trigger / list_runs / get_run_log) need API endpoints
//                           the official d.ts never states. Guessing paths is not alignment.
//
// WHAT MAKES THE FIRST TWO MORE THAN FIELD ADDITIONS
//   A field that is declared but ignored is worse than a missing one. So both assertions below
//   check that the value actually reaches something that uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

function schemaFields(chunkText, factoryName) {
  const at = chunkText.indexOf('var ' + factoryName + ' = lazySchema(');
  assert.ok(at > 0, 'schema factory not found: ' + factoryName);
  const seg = chunkText.slice(at, at + 6000);
  const open = seg.indexOf('{');
  let depth = 0;
  let end = -1;
  for (let k = open; k < seg.length; k += 1) {
    if (seg[k] === '{') depth += 1;
    else if (seg[k] === '}') { depth -= 1; if (depth === 0) { end = k; break; } }
  }
  const body = seg.slice(open, end + 1);
  const keys = [];
  let d = 0;
  for (const line of body.split('\n')) {
    if (d === 1) {
      const m = /^\s*([\w$]+)\??:/.exec(line);
      if (m) keys.push(m[1]);
    }
    d += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  return keys;
}

// ------------------------------------------------------------------ Monitor.timeout_ms
test('Monitor declares timeout_ms with the official bounds', () => {
  const chunk = findChunk('MonitorTool = buildTool(').text;
  const at = chunk.indexOf('MonitorTool = buildTool(');
  const getter = /get inputSchema\(\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\(\)/.exec(chunk.slice(at, at + 8000));
  assert.ok(getter, 'no inputSchema getter for MonitorTool');
  const fields = schemaFields(chunk, getter[1]);
  assert.ok(fields.includes('timeout_ms'), 'Monitor does not declare timeout_ms');

  const src = read('packages', 'builtin-tools', 'src', 'tools', 'MonitorTool', 'MonitorTool.tsx');
  assert.match(src, /MONITOR_DEFAULT_TIMEOUT_MS = 300_000/,
    'the official 300000ms default is gone');
  assert.match(src, /MONITOR_MAX_TIMEOUT_MS = 1_800_000/,
    'the official 1800000ms cap is gone');
});

test('Monitor actually enforces the deadline instead of accepting and ignoring it', () => {
  const src = read('packages', 'builtin-tools', 'src', 'tools', 'MonitorTool', 'MonitorTool.tsx');
  // Clamp, don't reject: the official contract says over-cap values are capped.
  assert.match(src, /Math\.min\(requestedTimeoutMs, MONITOR_MAX_TIMEOUT_MS\)/,
    'the value is no longer clamped to the official cap');
  assert.match(src, /killTask\(handle\.taskId, setAppState\)/,
    'nothing ends the monitor at expiry, so timeout_ms would be a no-op');
  assert.match(src, /clearTimeout\(timer\)/,
    'the timer is never cleared on abort, so it would fire against a dead task');
  // The deadline must be owned by the tool, not by the shared task system.
  assert.match(src, /timer\.unref\?\.\(\)/,
    'the timer keeps the process alive after the session ends');
});

// ------------------------------------------------------------------ Agent.effort
test('Agent declares effort with the official five-value enum', () => {
  const chunk = findChunk('AgentTool = buildTool(').text;
  const at = chunk.indexOf('AgentTool = buildTool(');
  const getter = /get inputSchema\(\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\(\)/.exec(chunk.slice(at, at + 12000));
  assert.ok(getter, 'no inputSchema getter for AgentTool');
  assert.ok(chunk.includes('"low"') && chunk.includes('"xhigh"') && chunk.includes('"max"'),
    'the effort enum is missing values');
  assert.ok(chunk.includes('Reasoning effort for this agent'),
    'the official effort description is absent');

  const src = read('packages', 'builtin-tools', 'src', 'tools', 'AgentTool', 'AgentTool.tsx');
  assert.match(src, /effort: z\s*\n?\s*\.enum\(\['low', 'medium', 'high', 'xhigh', 'max'\]\)/,
    'the source enum no longer matches the official five values');
});

test('Agent.effort reaches the query pipeline instead of being dropped', () => {
  // The whole point. An accepted-but-unused field would be the failure mode this guards.
  const src = read('packages', 'builtin-tools', 'src', 'tools', 'AgentTool', 'AgentTool.tsx');
  // \r? matters: this repository's source files use CRLF, and a bare \n regex fails to match
  // across the line break — which reported "effort is not destructured" on correct code.
  assert.match(src, /effort,\r?\n\s*run_in_background,/, 'effort is not destructured in call()');
  assert.equal((src.match(/effortOverride: effort/g) || []).length, 2,
    'effort is not threaded into BOTH SubagentContext constructions (async + sync)');

  const ctx = read('src', 'utils', 'agentContext.ts');
  assert.match(ctx, /effortOverride\?: EffortValue/,
    'SubagentContext has no effortOverride field');
  assert.match(ctx, /export function getSubagentEffortOverride\(\)/,
    'no reader is exported for the query pipeline');

  const query = read('src', 'query.ts');
  assert.match(query, /getSubagentEffortOverride\(\) \?\? appState\.effortValue/,
    'query.ts does not consult the override, so the value would be dropped');
});

test('the effort override is per-agent, not shared mutable state', () => {
  // agentContext.ts documents why AppState cannot carry this: concurrent agents overwrite it.
  // Putting the value on SubagentContext (AsyncLocalStorage) is what makes it race-free.
  const ctx = read('src', 'utils', 'agentContext.ts');
  assert.match(ctx, /AsyncLocalStorage/,
    'agentContext no longer uses AsyncLocalStorage, so per-agent isolation is gone');
  assert.match(ctx, /runWithAgentContext/,
    'the scope wrapper is gone');

  // And the query pipeline must fall back to the shared value, so the main loop is unaffected.
  const query = read('src', 'query.ts');
  assert.match(query, /appState\.effortValue/,
    'the shared effort value is no longer the fallback');
});

// ------------------------------------------------------------------ RemoteTrigger: the refusal
test('RemoteTrigger deliberately still lacks the three unimplementable actions', () => {
  // The official d.ts names `create_webhook_trigger`, `list_runs` and `get_run_log` but never
  // states their endpoints. The existing implementation builds URLs from
  // `${BASE_API_URL}/v1/code/triggers`, so those three would be guessed paths. Recording the
  // absence is the honest outcome; inventing them would produce calls that 404 in production.
  const src = read('packages', 'builtin-tools', 'src', 'tools', 'RemoteTriggerTool', 'RemoteTriggerTool.ts');
  assert.match(src, /z\.enum\(\['list', 'get', 'create', 'update', 'run'\]\)/,
    'the action enum changed: re-derive whether the three missing actions were added');
  assert.ok(!src.includes('create_webhook_trigger'),
    'create_webhook_trigger appeared: check whether its endpoint is actually known');
  assert.ok(!src.includes('list_runs'), 'list_runs appeared');
  assert.ok(!src.includes('get_run_log'), 'get_run_log appeared');

  // And the field gap that follows from those actions is still open.
  assert.ok(!/session_id:/.test(src), 'session_id appeared without the actions that need it');
  assert.ok(!/cursor:/.test(src), 'cursor appeared without the actions that need it');
});
