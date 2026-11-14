// R492: Artifact is not an incomplete implementation of a 20-field tool. It is a different, narrower tool.
//
// WHY THIS TOOL GOT ITS OWN ROUND
//   R491 measured all 44 shared tools: 26 fully covered, 3 partial, 10 with no directory. Artifact was the
//   worst partial at 2/20, and the only one where the implementation also has fields the contract lacks.
//   Mostly-disjoint field sets in both directions is the signature of "same name, different tool" — the
//   hazard R443 named when ProposeGoal/GoalTool and ProposeSkills/DiscoverSkills turned out to be opposites.
//   Quantifying the gap (R491) says how big it is; characterising it (this round) says what it is.
//
// WHAT THE OFFICIAL CONTRACT ACTUALLY DESCRIBES
//   `ArtifactInput.action` is a 13-value enum over ONE tool:
//       publish list read list_types watch unwatch status
//       upload_asset list_assets read_asset delete_asset pin unpin
//   with scope ("mine"|"shared"|"all"), page_token + limit for pagination, `url` to name an existing
//   artifact, asset_id to address an asset, out_dir + file_paths for batch asset upload, capabilities,
//   contract. Every field is optional because the tool dispatches on `action`.
//
// WHAT CCB IMPLEMENTS
//   packages/builtin-tools/src/tools/ArtifactTool declares THREE fields:
//       file_path   absolute path to a local .html or .md file
//       hash        overwrite an existing artifact by hash
//       ttl         7 or 30 days
//   Its declared name is the lower-case string 'artifact'. There is no `action`, no list/read/watch, no
//   asset verbs. It performs exactly one operation: upload a page and return a URL.
//
// SO THE RELATION IS A SUBSET IN BEHAVIOUR, NOT IN SCHEMA
//   CCB's tool is roughly the `publish` action, extended locally with `hash` and `ttl`. Reading the 18 absent
//   fields as "features to add" would be wrong: the gap is a dozen behaviours behind one discriminated
//   union, not eighteen missing parameters on a single call path.
//
// TWO PARSING MISTAKES, BOTH PRODUCING PLAUSIBLE NUMBERS
//   1. Reading the whole ArtifactTool directory as one blob reported 32 CCB fields, including
//      Authorization, headers, body, method, uploadUrl, expiresAt, is_error. Those are HTTP request and
//      response shapes from the upload client. A response interface has the same `name:` shape as a schema
//      object, so a text scan cannot tell them apart. Fixed by slicing to the `inputSchema` declaration
//      before scanning — nothing outside it describes what the tool accepts as input.
//   2. `url` was then reported as a SHARED field, because the client has an `uploadUrl`/`url` response
//      property. After the slice it correctly falls into "absent", since CCB's input schema has no `url`.
//
// A DOC-ATTRIBUTION TRAP NOTED BUT NOT SOLVED
//   The generated contract ends the `action` union and appends the NEXT field's doc on the same physical
//   line:
//       action?: | "publish" | ... | "unpin"; /** * Path to the .html file to render. Required to publish */
//       file_path?: string;
//   So "the comment above the field" attaches the wrong doc to every field following a union. The tool
//   therefore reports names and types only, and the semantics above come from reading the source, not from
//   proximity-based doc extraction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'artifact-divergence.cjs');
const CLI = path.join(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');
const CCB = path.join(ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'tools',
  'ArtifactTool');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

const haveBoth = fs.existsSync(CLI) && fs.existsSync(CCB);

test('the official tool is a 13-action manager', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, 'the tool failed:\n' + (result.stderr || '').slice(0, 900));
  const r = JSON.parse(result.stdout);

  assert.equal(r.officialFieldCount, 20, 'the official field count changed');
  assert.equal(r.officialActions.length, 13, 'the action count changed');
  for (const a of ['publish', 'list', 'read', 'watch', 'upload_asset', 'delete_asset', 'pin', 'unpin']) {
    assert.ok(r.officialActions.includes(a), `action ${a} disappeared from the enum`);
  }
});

test('the CCB implementation declares three fields and one operation', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);

  assert.deepEqual(r.ccbFields, ['file_path', 'hash', 'ttl'],
    'the CCB schema changed: ' + JSON.stringify(r.ccbFields));
  assert.equal(r.ccbToolName, 'artifact',
    'the CCB tool name changed; the lower-case name is what makes this an alias, not a match');

  // No action dispatch at all — that is the substance of the finding.
  const text = fs.readdirSync(CCB)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => fs.readFileSync(path.join(CCB, f), 'utf8')).join('\n');
  for (const verb of ['list_assets', 'upload_asset', 'delete_asset', 'unwatch', 'list_types']) {
    assert.ok(!text.includes(verb),
      `${verb} now appears in ArtifactTool: it may have grown action dispatch, so the conclusion changed`);
  }
});

test('only file_path is shared, and hash/ttl are local extensions', { skip: !haveBoth }, () => {
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);

  assert.deepEqual(r.present, ['file_path'], 'the shared field set changed: ' + JSON.stringify(r.present));
  assert.deepEqual(r.extra.sort(), ['hash', 'ttl'],
    'the CCB-only field set changed: ' + JSON.stringify(r.extra));
  // url must NOT be counted as shared — it is a response property, not an input.
  assert.ok(r.absent.includes('url'),
    'url is counted as a shared input field; the schema slice regressed and the client response leaked in');
  assert.equal(r.absent.length, 19, 'the absent count changed');
});

test('the extractor slices to inputSchema instead of scanning the directory', { skip: !haveBoth }, () => {
  // The first version reported 32 fields including HTTP response shapes.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /const start = text\.indexOf\('const inputSchema'\)/,
    'the schema slice is gone: response interfaces will be counted as input fields again');
  assert.match(source, /brace balance|depth \+= 1|depth \-= 1/,
    'the brace-balanced span is gone');
  // And the specific false positives must not be present.
  const result = run(['--json']);
  const r = JSON.parse(result.stdout);
  for (const bogus of ['Authorization', 'headers', 'uploadUrl', 'is_error', 'expiresAt', 'method']) {
    assert.ok(!r.ccbFields.includes(bogus),
      `${bogus} is reported as an input field: the directory-wide scan came back`);
  }
});

test('the tool self-checks the facts the conclusion rests on', { skip: !haveBoth }, () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /SELF-CHECK FAILED/, 'the self-check is gone');
  assert.match(source, /expected 13 action values/, 'the action-count check is gone');
  assert.match(source, /hash\/ttl|hash.*ttl/,
    'the extension check is gone: a change to hash/ttl would silently invalidate the conclusion');
  assert.match(source, /problems\.length/, 'the failures are no longer accumulated and acted on');
});

test('the tool states the relation and does not call the gap "missing fields"', () => {
  // The framing matters: 18 absent parameters on a dispatch union is not 18 features to add.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /subset-in-behaviour/, 'the relation label is gone');
  // The warning appears twice: in the header prose and in the machine-readable explanation field.
  assert.match(source, /not "the official Artifact with 18 fields missing"/,
    'the header no longer warns against reading the gap as missing parameters');
  assert.match(source, /official tool with fields removed/,
    'the explanation field no longer warns against reading the gap as missing parameters');
  assert.match(source, /narrower tool that shares the name/, 'the conclusion statement is gone');
});
