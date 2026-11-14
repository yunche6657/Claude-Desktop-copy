// R394: the §1 field-gap table must stay true against the vendored bundle.
//
// evidence/v6-worklist.md §1 claims CCB lacks 5 fields on Agent, 1 on EnterWorktree, and so on.
// Re-deriving it from the dist showed the Agent claim is wrong by four fields: name, team_name,
// mode and isolation are all declared. That correction only holds while the bundle does, so the
// field sets are pinned here.
//
// The extraction rules encoded below are the ones that survived four failed attempts:
//   - schemas are `var inputSchemaN = lazySchema(() => ...)`, reached via a GETTER on the tool
//   - Agent is assembled from baseInputSchema().merge(...).extend({...})
//   - the key scanner must skip whitespace before a key, or every schema looks empty
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'agent-core', 'claude-code', 'dist');
// Chunk filenames are bundler content hashes and change when a fresh build is adopted.
// Locating the table by a marker it uniquely contains keeps this test about the tool table.
const TABLE = readChunk('function getAllBaseTools()');

function balancedFrom(text, openIndex) {
  if (text[openIndex] !== '{') return null;
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return null;
}

/** Top-level keys of a pretty-printed object literal. Whitespace before a key must be skipped. */
function topLevelKeys(objText) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < objText.length; i += 1) {
    const ch = objText[i];
    if (ch === '{' || ch === '[' || ch === '(') { depth += 1; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth -= 1; continue; }
    if (depth !== 1 || !/[A-Za-z_$]/.test(ch)) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(objText.slice(i, i + 90));
    if (!m || /^(true|false|null|undefined)$/.test(m[1])) continue;
    let p = i - 1;
    while (p >= 0 && /\s/.test(objText[p])) p -= 1;
    if (p >= 0 && (objText[p] === '{' || objText[p] === ',')) keys.push(m[1]);
    i += m[0].length - 1;
  }
  return [...new Set(keys)];
}

/** The schema literal a named lazySchema factory declares. */
function schemaFields(factory, text = TABLE) {
  const decl = new RegExp('var ' + factory + ' = lazySchema\\(').exec(text);
  assert.ok(decl, `no lazySchema declaration for ${factory}`);
  const window = text.slice(decl.index, decl.index + 30_000);
  const own = /\b(?:strictObject|object)\(\s*\{/.exec(window);
  assert.ok(own, `no schema literal in ${factory}`);
  return topLevelKeys(balancedFrom(window, own.index + own[0].length - 1));
}

/**
 * A `const NAME = object({...})` declared INSIDE another factory.
 *
 * `multiAgentInputSchema` is a local const in fullInputSchema's body, not a top-level
 * `var ... = lazySchema(...)`, so schemaFields cannot reach it. Assuming every schema had the
 * lazySchema shape is what failed here.
 */
function innerObjectFields(name, text = TABLE) {
  const at = text.indexOf('const ' + name + ' = ');
  assert.ok(at > 0, `no inner object named ${name}`);
  const window = text.slice(at, at + 20_000);
  const own = /\bobject\(\s*\{/.exec(window);
  assert.ok(own, `no object literal for ${name}`);
  return topLevelKeys(balancedFrom(window, own.index + own[0].length - 1));
}


/**
 * Resolve a tool's own schema factory through its getter.
 *
 * `inputSchemaNN` numbers are bundler-assigned. Adding a tool in R403 shifted EnterWorktree from
 * inputSchema27 to inputSchema28 while inputSchema27 became EnterPlanMode's empty schema, so a
 * hardcoded number silently asserted against the wrong tool.
 */
function factoryFor(toolIdentifier) {
  const at = TABLE.indexOf(toolIdentifier + ' = buildTool(');
  assert.ok(at > 0, 'tool not found in the table chunk: ' + toolIdentifier);
  const seg = TABLE.slice(at, at + 12000);
  const getter = /get inputSchema\(\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\(\)/.exec(seg);
  assert.ok(getter, 'no inputSchema getter for ' + toolIdentifier);
  return getter[1];
}

test('the key scanner is not silently returning nothing', () => {
  // Measured: with the whitespace bug, EVERY schema came back as [] and the script still exited
  // 0. A non-empty known-good literal makes that failure impossible to miss.
  const fields = schemaFields(factoryFor('EnterWorktreeTool'));
  assert.ok(fields.length > 0, 'the scanner returned an empty field set: the whitespace skip is gone');
  // The sample must be a KNOWN-GOOD literal, so it is updated whenever the schema changes:
  // R405 added `path`. The point of the assertion is "non-empty and correct", not "still 1 field".
  assert.deepEqual(fields, ['name', 'path'],
    'the scanner returned the wrong literal: re-check the whitespace skip');
});

test('EnterWorktree declares name and path after R405 added path', () => {
  // WAS: asserted the field set was exactly ['name'], recording that the official `path` field
  // was missing. R405 added it, so this now asserts the aligned set instead. Same fact, updated.
  const fields = schemaFields(factoryFor('EnterWorktreeTool'));
  assert.deepEqual(fields.sort(), ['name', 'path'],
    'EnterWorktree no longer declares the R405 `path` field');
});

test('WebFetch input declares url+prompt+offset after R405', () => {
  // WAS: asserted only url+prompt, recording that `offset` was missing. R405 added it.
  const fields = schemaFields(factoryFor('WebFetchTool'));
  assert.deepEqual(fields.sort(), ['offset', 'prompt', 'url'],
    'WebFetch input no longer matches the R405 shape');
});

test('WebFetch output has eight fields after R405; artifactRead is still missing', () => {
  // New finding this round: the worklist only noted the input gap.
  // WAS: six fields, recording that official `artifactRead` was missing. R405 added
  // `contentOffset` and `contentLength`, so the count is now 8 and `artifactRead` remains the gap.
  const at = TABLE.indexOf('WebFetchTool = buildTool(');
  const getter = /get outputSchema\(\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\(\)/.exec(TABLE.slice(at, at + 12000));
  assert.ok(getter, 'no outputSchema getter for WebFetchTool');
  const fields = schemaFields(getter[1]);
  assert.equal(fields.length, 8,
    'the WebFetch output schema changed: re-derive the output gap. Got: ' + fields.join(', '));
  assert.ok(fields.includes('contentOffset') && fields.includes('contentLength'),
    'the R405 span fields are missing from the WebFetch output');
  assert.ok(!fields.includes('artifactRead'),
    'artifactRead appeared: the remaining WebFetch output gap closed');
});

test('Agent declares name, team_name, mode and isolation, contradicting the worklist', () => {
  // This is the R394 correction. The worklist lists all four as missing; they are present.
  const multi = innerObjectFields('multiAgentInputSchema');
  assert.deepEqual(multi.sort(), ['mode', 'name', 'team_name'],
    'the multi-agent merge changed: re-derive the Agent row');

  const base = schemaFields('baseInputSchema');
  // R406 added `effort` to baseInputSchema, closing the last §1 Agent gap. The row is otherwise
  // unchanged, so the rest of the list still records what CCB declares.
  assert.deepEqual(base.sort(),
    ['description', 'effort', 'model', 'prompt', 'run_in_background', 'subagent_type'],
    'baseInputSchema changed: re-derive the Agent row');
  assert.ok(base.includes('effort'),
    'effort vanished from baseInputSchema: the R406 addition was lost');

  // The extend() block is inline (no named schema), so read it from fullInputSchema's body.
  const at = TABLE.indexOf('var fullInputSchema = lazySchema(');
  const body = balancedFrom(TABLE, TABLE.indexOf('{', at));
  assert.ok(body.includes('isolation:'), 'Agent no longer extends with isolation');
  assert.ok(body.includes('cwd:'), 'Agent no longer extends with cwd');

  const agentFields = new Set([...base, ...multi, 'isolation', 'cwd']);
  // WAS: "effort is the ONE official field genuinely absent". R406 added it, so the §1.1 gap is
  // closed and the assertion flips. Same fact, updated.
  assert.ok(agentFields.has('effort'),
    'effort vanished from the Agent field set: the R406 addition was lost');
  for (const present of ['name', 'team_name', 'mode', 'isolation']) {
    assert.ok(agentFields.has(present),
      `${present} vanished from Agent: the worklist's "missing" claim became true again`);
  }
});

test('isolation is narrowed to worktree for non-ant users', () => {
  // Not in any worklist: the value set depends on USER_TYPE, while the official type is a plain
  // union of worktree|remote regardless of user.
  const at = TABLE.indexOf('var fullInputSchema = lazySchema(');
  const body = balancedFrom(TABLE, TABLE.indexOf('{', at));
  assert.match(body, /USER_TYPE === "ant"[\s\S]{0,120}_enum\(\["worktree", "remote"\]\)/,
    'the isolation value set no longer branches on USER_TYPE: re-derive that差异');
});

test('Monitor and RemoteTrigger field sets still match the comparison', () => {
  const monitorSrc = readChunk('MonitorTool = buildTool(');
  // R406 added `timeout_ms`, so Monitor is no longer command+description only. `ws` is still
  // missing — that needs a WebSocket transport the tool does not have.
  assert.deepEqual(schemaFields('inputSchema', monitorSrc).sort(),
    ['command', 'description', 'timeout_ms'],
    'Monitor schema changed: re-derive §1.4');

  const remoteSrc = readChunk('RemoteTriggerTool = buildTool(');
  assert.deepEqual(schemaFields('inputSchema', remoteSrc).sort(), ['action', 'body', 'trigger_id'],
    'RemoteTrigger schema changed: re-derive §1.5');
});
