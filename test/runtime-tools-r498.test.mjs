// R498: the CLI reports its own tool list at runtime, and it disagrees with the contract the last six rounds
// used as their denominator.
//
// THE TURN
//   R488–R494 compared contract files to source files. Every figure — 44 tools, 26 fully covered, Artifact
//   divergent — came from parsing text I wrote a parser for. None of it was checked against what the shipped
//   binary says about itself.
//
//   It turns out the binary says it plainly. With `--output-format stream-json` the first frame is
//         {"type":"system","subtype":"init", ..., "tools":[...]}
//   That is ground truth produced by the artifact under study rather than by my parser.
//
// HOW IT IS OBTAINED WITHOUT CREDENTIALS
//   R482 established that the login gate checks for the PRESENCE of a credential, not its validity, and that a
//   base URL pointing at a closed port still lets the CLI assemble tools and reach the API-retry stage. So the
//   probe isolates HOME/CLAUDE_CONFIG_DIR (R481 showed the environment is load-bearing), sets
//   ANTHROPIC_BASE_URL=http://127.0.0.1:9 with a synthetic token, and reads the first frame. The process is
//   then retrying a dead endpoint and is killed by the timeout — expected, and the frame is already captured.
//
// WHAT THE COMPARISON FOUND
//   Runtime: 39 tools. Contract union: 44. Contract tools present: 26.
//
//   Five of the differences are pure RENAMING, established from the source's own constants:
//       FileReadTool  declares 'Read'        (the contract says FileRead)
//       FileEditTool  declares 'Edit'
//       FileWriteTool declares 'Write'
//       ArtifactTool  declares 'artifact'    (lower case)
//       AgentTool     declares both 'Agent' and 'Task'
//   Before the alias table, the tool reported those as missing. That is the same error as R488's false
//   "unreproducible denominator", one layer down: comparing the wrong two names and reading the mismatch as a
//   property of the code.
//
//   Eighteen contract tools are genuinely absent from the runtime list. Twelve of those the earlier rounds
//   already classified as no-implementation. But four are not: TaskCreate, TaskGet, TaskList and TaskUpdate
//   have source directories that declare exactly those names, and R491 recorded them as implemented. The
//   runtime does not assemble them. So "the directory exists" and "the tool is registered" are different
//   facts, and R491 conflated them.
//
//   Fourteen registered tools are absent from the contract entirely — Task, DiscoverSkills, GoalTool,
//   PowerShell, TeamCreate/Delete, VaultHttpFetch and others. Whatever the contract describes, it is not this
//   build's surface.
//
// WHAT THIS DOES NOT ESTABLISH
//   Names only. The init frame has no schema, so nothing here speaks to field agreement; R490/R491's static
//   field comparison is untouched. It also does not establish that the 18 absent tools are unimplemented —
//   some may be feature-gated, as the debug log shows for SearchExtraTools.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'runtime-tools.cjs');

// This probe spawns the real CLI and waits for its first frame, so it needs a generous timeout.
const run = () => spawnSync(process.execPath, [TOOL, '--json'], {
  cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true,
});

const haveCli = fs.existsSync(path.join(ROOT, 'agent-core', 'bun', 'bun.exe'))
  && fs.existsSync(path.join(ROOT, 'agent-core', 'claude-code', 'dist', 'cli-bun.js'));

test('the CLI registers a tool list that can be read without credentials', { skip: !haveCli }, () => {
  const direct = run();
  assert.equal(direct.status, 0, 'the probe failed:\n' + (direct.stderr || '').slice(0, 900));
  const d = JSON.parse(direct.stdout);

  assert.ok(Array.isArray(d.runtimeTools), 'no runtime tool list');
  assert.ok(d.runtimeTools.length >= 30,
    `only ${d.runtimeTools.length} tools registered: the probe may have read the wrong frame`);
  // A frame with a session id means the CLI really reached the init stage, not an early error path.
  assert.ok(d.sessionId, 'no session id in the init frame');
  // Names must be unique.
  assert.equal(new Set(d.runtimeTools).size, d.runtimeTools.length, 'duplicate tool names in the frame');
});

test('the contract and the runtime disagree, and that disagreement is the finding', { skip: !haveCli }, () => {
  const d = JSON.parse(run().stdout);
  assert.equal(d.contractCount, 44, 'the contract tool count changed');
  assert.equal(d.matchedCount, 26,
    `contract tools matched changed to ${d.matchedCount}: re-derive the coverage discussion`);
  assert.ok(d.unmatched.length > 0,
    'contract and runtime now agree completely — the whole premise of this round would be void');
  assert.ok(d.registeredOnly.length > 0,
    'nothing is registered outside the contract: re-derive whether the contract describes this build');
});

test('the five renames are recorded, because comparing the wrong names looks like missing tools', { skip: !haveCli }, () => {
  const d = JSON.parse(run().stdout);
  const byContract = new Map(d.matched.map((m) => [m.contract, m.registered]));

  // Renames established from the source's *TOOL_NAME constants.
  assert.equal(byContract.get('FileRead'), 'Read', 'FileRead no longer maps to Read');
  assert.equal(byContract.get('FileEdit'), 'Edit', 'FileEdit no longer maps to Edit');
  assert.equal(byContract.get('FileWrite'), 'Write', 'FileWrite no longer maps to Write');
  assert.equal(byContract.get('Artifact'), 'artifact', 'Artifact no longer maps to the lower-case name');

  // And none of those four may appear in the unmatched list.
  for (const name of ['FileRead', 'FileEdit', 'FileWrite', 'Artifact']) {
    assert.ok(!d.unmatched.includes(name),
      `${name} is reported unmatched again: the alias table regressed and a rename looks like a gap`);
  }

  // Source evidence for the claim, so it is not a hardcoded assertion with no grounding.
  const src = path.join(ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'tools');
  if (fs.existsSync(path.join(src, 'FileReadTool'))) {
    const text = fs.readdirSync(path.join(src, 'FileReadTool'))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => fs.readFileSync(path.join(src, 'FileReadTool', f), 'utf8')).join('\n');
    assert.match(text, /TOOL_NAME\s*=\s*['"]Read['"]/,
      'FileReadTool no longer declares TOOL_NAME Read: the alias premise changed');
    assert.ok(!/TOOL_NAME\s*=\s*['"]FileRead['"]/.test(text),
      'FileReadTool now declares FileRead as well: re-derive the rename conclusion');
  }
});

test('a directory declaring a name is not the same as the tool being registered', { skip: !haveCli }, () => {
  // R491 recorded TaskCreate/TaskGet/TaskList/TaskUpdate as implemented because their directories exist and
  // declare those names. The runtime does not assemble them. Both facts are true; only one was checked.
  const d = JSON.parse(run().stdout);
  for (const name of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']) {
    assert.ok(d.unmatched.includes(name),
      `${name} is no longer absent from the runtime list: re-derive the directory-vs-registration point`);
  }

  // Confirm the directories really do declare those names, so the absence is about assembly not naming.
  const src = path.join(ROOT, '..', '.tmp', 'ccb-src', 'packages', 'builtin-tools', 'src', 'tools');
  for (const [dir, tool] of [['TaskCreateTool', 'TaskCreate'], ['TaskListTool', 'TaskList']]) {
    const p = path.join(src, dir);
    if (!fs.existsSync(p)) continue;
    const text = fs.readdirSync(p).filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => fs.readFileSync(path.join(p, f), 'utf8')).join('\n');
    assert.ok(text.includes(`'${tool}'`),
      `${dir} no longer declares ${tool}: the directory-vs-registration distinction has no evidence`);
  }
});

test('the probe uses an isolated profile and a dead endpoint', () => {
  // Two preconditions that make the probe safe and credential-free. If either is removed it either touches the
  // real user profile or needs a live account.
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /CLAUDE_CONFIG_DIR\s*=\s*home/, 'the profile is no longer isolated');
  assert.match(source, /ANTHROPIC_BASE_URL\s*=\s*'http:\/\/127\.0\.0\.1:9'/,
    'the base URL is no longer a closed port: the probe would need a real endpoint');
  assert.match(source, /delete env\.ELECTRON_RUN_AS_NODE/,
    'ELECTRON_RUN_AS_NODE is no longer removed: the child would not run as a normal node process');
});

test('the tool states that it compares names only', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /Names only/, 'the tool no longer limits its claim to names');
  assert.match(source, /no schema/i,
    'the tool no longer says the init frame carries no schema');
});
