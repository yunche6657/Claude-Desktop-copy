// R410: ReportFindings has NO supporting mechanism in CCB — not a missing UI, not a missing
// protocol capability, but a completely absent findings lifecycle.
//
// WHY THIS FILE EXISTS
//   During the investigation three things LOOKED like findings infrastructure and had to be
//   ruled out one by one. Recording the exclusions is the useful part: without them, the next
//   person sees `verdict?.isReal` in ultracode.ts or "Findings arrive via task-notification" in
//   reviewRemote.ts and concludes the mechanism exists.
//
//   Also pinned: the tool's official output is an ECHO of its input plus a count. That shape is
//   the evidence that it does not persist anything — and therefore that a CCB implementation
//   with no consuming UI would be a guaranteed-success no-op.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const DIST = path.join(ROOT, 'agent-core', 'claude-code', 'dist');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

test('the official output is an echo of the input plus a count', () => {
  // This is the load-bearing reading. If the output ever gains state (an id, a persisted path,
  // a review session handle), the conclusion changes: there would be something to store.
  const dts = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
  assert.ok(fs.existsSync(dts), 'the official sdk-tools.d.ts is missing');
  const text = fs.readFileSync(dts, 'utf8');

  const at = text.indexOf('export interface ReportFindingsOutput');
  assert.ok(at > 0, 'ReportFindingsOutput moved');
  const open = text.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = text.slice(open, end + 1);

  assert.match(body, /count:\s*number/, 'the output no longer carries a count');
  assert.match(body, /findings:/, 'the output no longer echoes findings');
  // No persistence handle of any kind.
  for (const forbidden of ['id:', 'sessionId', 'path:', 'url:']) {
    assert.ok(!new RegExp('\\b' + forbidden).test(body),
      'ReportFindingsOutput gained ' + forbidden
      + ', which would mean findings are stored somewhere and this analysis must be redone');
  }
  assert.match(text, /Echoed for the result body/,
    'the "echoed" wording changed: re-read whether the output persists anything');
});

test('CCB has none of the tools own vocabulary', () => {
  // The cleanest single measurement: these identifiers exist only in the official contract.
  const files = [...walk(path.join(SRC, 'src')), ...walk(path.join(SRC, 'packages'))];
  assert.ok(files.length > 500, 'expected a large source tree, got ' + files.length);

  for (const term of ['short_summary', 'failure_scenario', 'no_change_needed']) {
    const hits = files.filter((f) => {
      if (/\.test\./.test(f) || f.includes('__tests__')) return false;
      return fs.readFileSync(f, 'utf8').includes(term);
    });
    assert.deepEqual(hits.map((f) => path.relative(SRC, f)), [],
      term + ' appeared in the source: findings infrastructure may exist now, revisit §4');
  }
});

test('the workflow-engine findings example is NOT tool infrastructure', () => {
  // Exclusion 1. It uses the word `findings` but is a demo of workflow orchestration.
  const p = path.join(SRC, 'packages', 'workflow-engine', 'examples', 'research-report', 'run.ts');
  assert.ok(fs.existsSync(p), 'the workflow example moved; re-check the exclusion');
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(/findingsDeepened/.test(text),
    'the example no longer mentions findings, so this exclusion may be stale');
  // It is under examples/, not imported by the tool registry.
  assert.ok(p.includes('examples'),
    'the example moved out of examples/, so it may now be load-bearing');
});

test('ultracode findings code is a PROMPT EXAMPLE, not a data structure', () => {
  // Exclusion 2. `verdict?.isReal` tempted a false conclusion here.
  const p = path.join(SRC, 'src', 'skills', 'bundled', 'ultracode.ts');
  assert.ok(fs.existsSync(p), 'the ultracode skill moved; re-check the exclusion');
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes('verdict?.isReal'),
    'the ultracode verdict example changed; re-derive the exclusion');
  // The decisive fact: the surrounding text teaches pipeline() composition.
  assert.ok(text.includes('DEFAULT TO pipeline()'),
    'the ultracode file no longer reads like a prompt guide, so its findings code may be real');
  assert.ok(text.includes('FINDINGS_SCHEMA'),
    'FINDINGS_SCHEMA is gone; re-check whether it was only an example variable');
});

test('task-notification is message routing, not a findings container', () => {
  // Exclusion 3. reviewRemote.ts says "Findings arrive via task-notification" — that is the
  // delivery channel for worker results, not storage.
  const coord = fs.readFileSync(path.join(SRC, 'src', 'coordinator', 'coordinatorMode.ts'), 'utf8');
  assert.match(coord, /<task-notification>/, 'the task-notification format changed');
  assert.match(coord, /Worker results arrive as \*\*user-role messages\*\*/,
    'the task-notification description changed; re-derive what it carries');

  const query = fs.readFileSync(path.join(SRC, 'src', 'query.ts'), 'utf8');
  assert.match(query, /cmd\.mode === 'task-notification'/,
    'task-notification is no longer a queue mode, so it may now be a real container');
});

test('ReportFindings is still absent from the bundle', () => {
  const tableFile = fs.readdirSync(DIST)
    .filter((n) => n.endsWith('.js') && fs.statSync(path.join(DIST, n)).size < 20_000_000)
    .find((n) => fs.readFileSync(path.join(DIST, n), 'utf8').includes('function getAllBaseTools()'));
  assert.ok(tableFile, 'the tool table is missing from the vendored bundle');
  const table = fs.readFileSync(path.join(DIST, tableFile), 'utf8');
  assert.ok(!table.includes('ReportFindingsTool'),
    'ReportFindingsTool is registered: §2 was implemented, update the worklist and this file');
  // Contrast: the two additions that DID happen stay visible.
  assert.ok(table.includes('ProposeGoalTool') && table.includes('RefreshMcpToolsTool'),
    'an earlier addition vanished');
});
