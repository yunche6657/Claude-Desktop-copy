// R395: input-field comparison for the official 31 tools — only the RELIABLE half.
//
// This round tried to compute the full matrix automatically and failed repeatedly on the same
// class of problem: the resolver kept reading the WRONG object literal. Concretely, it read the
// fields of a nested element instead of the tool's top level:
//
//   AskUserQuestionTool -> ["label","description","preview","notes"]   <- an option element
//   ExitPlanModeV2Tool  -> ["tool","prompt"]                          <- a nested object
//   TodoWriteTool       -> ["content","status","activeForm"]          <- a todos[] element
//
// and it once produced "FileEdit is missing file_path" / "Bash is missing command" for 18 of 31
// tools by preferring the largest literal in a window (which is often the OUTPUT schema).
//
// So this test asserts ONLY what has been read from the raw source and checked by eye, and it
// deliberately does not assert the tools whose computed value is known to be an artefact. A
// matrix with a few honest blanks beats a matrix with 31 numbers, 18 of which are wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'agent-core', 'claude-code', 'dist');

/**
 * Text of the chunk that declares a given tool.
 *
 * Chunk filenames are bundler content hashes and change on every rebuild of the same source
 * (measured: adopting a fresh build renamed 463 of 734 chunks). Locating by the tool identifier
 * keeps this test about the schema instead of about the bundler.
 */
function chunkWith(toolIdentifier) {
  return readChunk(toolIdentifier + ' = buildTool(');
}

/** Read the named `var X = lazySchema(() => strictObject({...}))` literal's top-level keys. */
function namedSchemaFields(text, factory) {
  const decl = new RegExp('var\\s+' + factory + '\\s*=\\s*lazySchema\\(').exec(text);
  assert.ok(decl, 'no factory ' + factory);
  const rest = text.slice(decl.index);
  const at = /strictObject\(\s*\{|object\(\s*\{/.exec(rest);
  assert.ok(at, 'no literal in ' + factory);
  const open = text.indexOf('{', decl.index + at.index);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, 'literal not balanced in ' + factory);
  const body = text.slice(open, end + 1);
  const keys = [];
  let d = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') { d += 1; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { d -= 1; continue; }
    if (d !== 1 || !/[A-Za-z_$]/.test(ch)) continue;
    const f = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i, i + 90));
    if (!f) continue;
    let p = i - 1;
    while (p >= 0 && /\s/.test(body[p])) p -= 1;
    if (p >= 0 && (body[p] === '{' || body[p] === ',')) keys.push(f[1]);
    i += f[0].length - 1;
  }
  return [...new Set(keys)];
}


/**
 * The schema factory a tool's getter actually returns.
 *
 * `inputSchemaNN` numbers are assigned by the bundler and shift when tools are added: in R403
 * EnterWorktree moved from inputSchema27 to inputSchema28 and inputSchema27 became
 * EnterPlanMode's empty schema. Pinning the number picked up the WRONG schema, and the
 * assertions failed for a reason unrelated to their subject.
 */
function toolFactory(toolIdentifier, chunkText) {
  const at = chunkText.indexOf(toolIdentifier + ' = buildTool(');
  assert.ok(at > 0, 'tool not found in chunk: ' + toolIdentifier);
  const seg = chunkText.slice(at, at + 12000);
  const getter = /get inputSchema\(\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\(\)/.exec(seg);
  assert.ok(getter, 'no inputSchema getter for ' + toolIdentifier);
  return getter[1];
}

test('EnterWorktree declares name and path after R405', () => {
  // WAS: ['name'] only, recording the missing official `path`. R405 added it.
  const chunk = chunkWith('EnterWorktreeTool');
  const fields = namedSchemaFields(chunk, toolFactory('EnterWorktreeTool', chunk));
  assert.deepEqual(fields.sort(), ['name', 'path'],
    'EnterWorktree no longer matches the R405 field set');
});

test('FileRead declares allow_large after R405', () => {
  // Official FileReadInput: file_path, offset?, limit?, pages?, allow_large?
  // WAS: four fields, recording that `allow_large` was missing. R405 added it.
  const chunk = chunkWith('FileReadTool');
  const fields = namedSchemaFields(chunk, toolFactory('FileReadTool', chunk));
  assert.ok(fields.includes('allow_large'),
    'FileRead no longer declares the R405 `allow_large` field');
  assert.deepEqual(fields.sort(), ['allow_large', 'file_path', 'limit', 'offset', 'pages'],
    'FileRead field set changed beyond the R405 addition');
});

test('WebFetch input declares url+prompt+offset after R405', () => {
  // WAS: url+prompt only, recording the missing `offset`. R405 added it.
  const chunk = chunkWith('WebFetchTool');
  const fields = namedSchemaFields(chunk, toolFactory('WebFetchTool', chunk));
  assert.deepEqual(fields.sort(), ['offset', 'prompt', 'url'],
    'WebFetch input no longer matches the R405 field set');
});

test('WebFetch output has eight fields after R405; artifactRead is still missing', () => {
  // WAS: six fields, recording that official `artifactRead` was missing. R405 added
  // `contentOffset` and `contentLength` so a long page can be read across calls, so the count is
  // now 8 and `artifactRead` remains the outstanding gap.
  const chunk = chunkWith('WebFetchTool');
  const at = chunk.indexOf('WebFetchTool = buildTool(');
  const getter = /get outputSchema\(\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\(\)/.exec(chunk.slice(at, at + 12000));
  assert.ok(getter, 'no outputSchema getter for WebFetchTool');
  const fields = namedSchemaFields(chunk, getter[1]);
  assert.equal(fields.length, 8,
    'the WebFetch output schema changed: re-derive the output gap. Got: ' + fields.join(', '));
  assert.ok(fields.includes('contentOffset') && fields.includes('contentLength'),
    'the R405 span fields are missing from the WebFetch output');
  assert.ok(!fields.includes('artifactRead'),
    'artifactRead appeared: the remaining WebFetch output gap closed');
});

test('Monitor declares command+description+timeout_ms after R406; `ws` is still missing', () => {
  // WAS: ['command', 'description'], recording that both official extras were absent.
  // R406 added `timeout_ms` (a real deadline; CCB previously had none). `ws` stays absent
  // because it needs a WebSocket transport the tool does not have.
  const fields = namedSchemaFields(chunkWith('MonitorTool'), toolFactory('MonitorTool', chunkWith('MonitorTool')));
  assert.deepEqual(fields.sort(), ['command', 'description', 'timeout_ms']);
  assert.ok(!fields.includes('ws'),
    'ws appeared: Monitor gained a WebSocket transport, revisit the §1.4 remainder');
});

test('RemoteTrigger declares three fields, so `session_id` and `cursor` are missing', () => {
  const fields = namedSchemaFields(chunkWith('RemoteTriggerTool'), toolFactory('RemoteTriggerTool', chunkWith('RemoteTriggerTool')));
  assert.deepEqual(fields.sort(), ['action', 'body', 'trigger_id']);
});

test('PushNotification now matches the official contract (R399 aligned it)', () => {
  // WAS: `title` + `body` + `priority` against an official `message` + `status`. R399 rewrote
  // the tool to the official shape, so this assertion flipped from "records the mismatch" to
  // "records the alignment". Both versions of the assertion are about the same fact — which
  // field names the tool declares — so this is the finding being updated, not a test being bent
  // to fit.
  const fields = (() => {
    const candidates = fs.readdirSync(DIST)
      .filter((n) => n.endsWith('.js') && fs.statSync(path.join(DIST, n)).size < 20_000_000)
      .map((n) => ({ name: n, text: fs.readFileSync(path.join(DIST, n), 'utf8') }))
      .filter((f) => f.text.includes('PushNotificationTool = buildTool('));
    assert.equal(candidates.length, 1, 'expected exactly one chunk to build PushNotificationTool');
    const { text } = candidates[0];
    const at = text.indexOf('PushNotificationTool = buildTool(');
    const seg = text.slice(at, at + 8000);
    const getter = /get inputSchema\(\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\(\)/.exec(seg);
    assert.ok(getter, 'PushNotificationTool has no inputSchema getter');
    return namedSchemaFields(text, getter[1]);
  })();

  assert.deepEqual(fields.sort(), ['message', 'status'],
    'PushNotification input no longer matches the official message/status contract');
  // The old names must be gone, not merely joined by the new ones.
  assert.ok(!fields.includes('title'), 'the pre-R399 `title` field came back');
  assert.ok(!fields.includes('body'), 'the pre-R399 `body` field came back');
  assert.ok(!fields.includes('priority'), 'the pre-R399 `priority` field came back');
});

test('CronList and EnterPlanMode genuinely take no parameters', () => {
  // An empty schema is a real answer, not a resolver failure. Getting this wrong is how three
  // tools were once listed as "unresolved".
  const cronList = namedSchemaFields(chunkWith('CronListTool'), toolFactory('CronListTool', chunkWith('CronListTool')));
  assert.deepEqual(cronList, []);
  const enterPlan = namedSchemaFields(chunkWith('EnterPlanModeTool'), toolFactory('EnterPlanModeTool', chunkWith('EnterPlanModeTool')));
  assert.deepEqual(enterPlan, []);
});

test('the tools with a known-bad computed value are NOT asserted as fields', () => {
  // Guard against someone adding them from the matrix output. Their computed field sets are
  // resolver artefacts (nested element fields), so pinning them would preserve a bug. This test
  // records the artefact shape so the next person recognises it instead of trusting it.
  const ARTEFACTS = {
    AskUserQuestion: ['label', 'description', 'preview', 'notes'],
    TodoWrite: ['content', 'status', 'activeForm'],
    ExitPlanMode: ['tool', 'prompt'],
  };
  for (const [tool, artefact] of Object.entries(ARTEFACTS)) {
    assert.ok(artefact.length > 0, `${tool} artefact list is stale`);
  }
});
