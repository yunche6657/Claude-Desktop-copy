// R388: the `Workflow` contract comparison (worklist §4b) must stay true as the pinned bundle
// and the vendored CCB dist are what they are.
//
// This pins three findings that are easy to lose:
//   1. CCB's workflow input schema exists in the repository's own dist, and has exactly the
//      fields the comparison recorded. If a future re-adopt changes it, the field list in
//      evidence/workflow-contract-4b.md becomes wrong silently.
//   2. `description` / `title` are documented as INPUTS in CCB but as IGNORED in the official
//      SDK. That disagreement is the finding; a schema edit that made CCB match the official
//      notice would flip it.
//   3. The tool has NO feature flag: it is assigned unconditionally and reports
//      `isEnabled: () => true`. The worklist suspected the opposite ("不带 flag 等于没有"), so
//      this is a correction worth failing on.
//
// The official side is not re-downloaded here: npm access is not a test-time guarantee. The
// recorded official field list is asserted against the checked-in evidence document instead,
// so the two halves cannot drift apart without this failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'agent-core', 'claude-code', 'dist');
const EVIDENCE = path.join(ROOT, 'evidence', 'workflow-contract-4b.md');

function dist(name) {
  const p = path.join(DIST, name);
  assert.ok(fs.existsSync(p), `the vendored CCB dist is missing ${name}`);
  return fs.readFileSync(p, 'utf8');
}

/** The `workflowInputSchema` object literal, as a field -> line map. */
function ccbSchemaFields() {
  const text = readChunk('var workflowInputSchema2 = object({');
  const start = text.indexOf('var workflowInputSchema2 = object({');
  assert.ok(start > 0, 'the workflow input schema is gone from the vendored dist');
  const end = text.indexOf('});', start);
  const body = text.slice(start, end);
  const fields = {};
  for (const line of body.split('\n')) {
    const m = line.trim().match(/^(\w+)\s*:\s*(.+?),?$/);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

test('the CCB workflow input schema still has exactly the compared fields', () => {
  const fields = Object.keys(ccbSchemaFields()).sort();
  assert.deepEqual(fields, [
    'args', 'description', 'maxConcurrency', 'name', 'resumeFromRunId', 'script', 'scriptPath', 'title',
  ], 'the vendored workflow schema changed; redo the §4b comparison');
});

test('CCB documents description/title as inputs, which is the disagreement with the SDK', () => {
  // The official SDK marks both as "Ignored — set it in the script's meta block". CCB describes
  // them as real parameters. If this ever becomes optional/ignored here, §4b's finding is stale.
  const schema = ccbSchemaFields();
  assert.match(schema.description, /describe\(/, 'description lost its description text');
  assert.match(schema.title, /describe\(/, 'title lost its description text');
  assert.doesNotMatch(schema.description, /ignored/i, 'CCB now matches the SDK: update §4b');
  assert.doesNotMatch(schema.title, /ignored/i, 'CCB now matches the SDK: update §4b');
});

test('maxConcurrency is CCB-only, so the official field set is a strict subset', () => {
  const fields = Object.keys(ccbSchemaFields());
  assert.ok(fields.includes('maxConcurrency'), 'the CCB-only field disappeared');
  const evidence = fs.readFileSync(EVIDENCE, 'utf8');
  // The document holds TWO tables with the same field names (official, then CCB), so a bare
  // `includes('`args`')` check is satisfied by the CCB table alone — measured: deleting the
  // official row left the assertion green. Pin the official row by the TYPE it records, which
  // is what distinguishes the two tables.
  const OFFICIAL_ROWS = {
    script: '| `script` | `string?` |',
    name: '| `name` | `string?` |',
    description: '| `description` | `string?` | **Ignored**',
    title: '| `title` | `string?` | **Ignored**',
    args: '| `args` | `{ [k: string]: unknown }?` |',
    scriptPath: '| `scriptPath` | `string?` |',
    resumeFromRunId: '| `resumeFromRunId` | `string?` |',
  };
  for (const [official, row] of Object.entries(OFFICIAL_ROWS)) {
    assert.ok(fields.includes(official), `official field ${official} is missing from CCB`);
    assert.ok(evidence.includes(row), `§4b no longer records the official row for ${official}: expected ${row}`);
  }
});

test('the workflow tool has no feature flag and is enabled unconditionally', () => {
  // Three links, all needed: unconditional assignment, a registration line that looks like a
  // gate but is not, and the inner isEnabled.
  const tools = readChunk('function getAllBaseTools()');
  // The chunk name in this import is a bundler content hash and changes on every rebuild, so
  // the assertion pins the CONTRACT — assigned unconditionally from createWorkflowToolCore() —
  // and accepts any hash. Pinning the hash made this test fail after adopting a fresh build of
  // the same pinned source, which was a test defect, not a finding.
  assert.match(tools, /var WorkflowTool = import\.meta\.require\("\.\/chunk-[a-z0-9]+\.js"\)\.createWorkflowToolCore\(\);/,
    'the workflow tool is no longer assigned unconditionally: a flag may exist now');
  assert.ok(!/var WorkflowTool = [^;]*\?/.test(tools),
    'the workflow tool assignment now contains a conditional: recheck whether it is gated');
  assert.match(tools, /\.\.\.WorkflowTool \? \[WorkflowTool\] : \[\],/,
    'the registration line changed shape; recheck whether it is now a real gate');
  // Contrast: this file DOES gate other tools on env, so the absence above is meaningful.
  assert.match(tools, /process\.env\.CLAUDE_CODE_VERIFY_PLAN === "true" \? [^:]+ : null/,
    'the surrounding contrast case is gone, so "no flag" can no longer be argued from this file');

  // Must be the chunk that DEFINES the factory. Three chunks contain the identifier
  // `createWorkflowToolCore` (the table's import binding, a re-export, and the definition);
  // the first match was a stub with `isEnabled: () => true`, so this test asserted against the
  // wrong module. Anchor on the real implementation line instead.
  const wrapper = readChunk('isEnabled: () => descriptor().isEnabled()');
  assert.match(wrapper, /isEnabled: \(\) => descriptor\(\)\.isEnabled\(\)/, 'the wrapper now gates on its own');

  const inner = readChunk('var workflowInputSchema2 = object({');
  assert.match(inner, /isEnabled: \(\) => true/,
    'the inner tool gained a condition: §4b.2 no longer says "always visible"');
});
