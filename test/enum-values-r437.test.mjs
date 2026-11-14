// R437: enum VALUE SETS compared member-by-member — the gap R436 left open.
//
// WHAT R436 SAID IT HAD NOT DONE
//   "我只在 CCB 是 z.enum 时确认官方也是字面量联合，没有逐值列出差集."
//   So "both sides are enums" was established; "the same members" was not. A dropped enum member
//   means the model can never select that category and NOTHING fails, because optional fields are
//   optional. That is why this deserves its own pass.
//
// RESULT
//   Ten official closed-set input fields. Six compare directly (literal z.enum) and match exactly.
//   Four use indirection — a shared schema, a conditional on an env var, or a widened string — and
//   are resolved here. One real difference found: `Agent.model` is a closed set of four literals in
//   the contract but an unrestricted `z.string()` in CCB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const dts = () => read(DTS);

/** Parse the depth-0 members of an interface into {name: typeText}. */
function officialMembers(iface) {
  const contract = dts();
  const m = new RegExp('export interface ' + iface + '\\b[^{]*\\{').exec(contract);
  assert.ok(m, iface + ' is gone from the contract');
  const s = m.index + m[0].length;
  let depth = 1;
  let i = s;
  while (i < contract.length && depth) {
    if (contract[i] === '{') depth += 1;
    else if (contract[i] === '}') depth -= 1;
    i += 1;
  }
  const body = contract.slice(s, i - 1);

  const out = {};
  let memberDepth = 0;
  let name = null;
  let parts = [];
  const flush = () => {
    if (name !== null) out[name] = parts.join(' ');
    name = null;
    parts = [];
  };
  for (const line of body.split('\n')) {
    const bare = line.trim();
    if (memberDepth === 0) {
      const mm = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(bare);
      if (mm) {
        flush();
        name = mm[1];
        parts = [bare.slice(mm[0].length)];
      } else if (name !== null) {
        parts.push(bare);
      }
    } else {
      parts.push(bare);
    }
    memberDepth += (line.match(/\{/g) || []).length + (line.match(/\[/g) || []).length;
    memberDepth -= (line.match(/\}/g) || []).length + (line.match(/\]/g) || []).length;
    if (memberDepth < 0) memberDepth = 0;
    if (memberDepth === 0 && bare.endsWith(';') && name !== null) flush();
  }
  flush();
  return out;
}

/** String literals of a closed-set member, or null when the member is not one. */
function literalsOf(typeText) {
  assert.ok(typeText !== undefined, 'member not found');
  const flat = typeText.replace(/\s+/g, ' ').trim().replace(/;$/, '').replace(/^\|\s*/, '');
  const parts = flat.split('|').map((p) => p.trim());
  if (parts.length < 2) return null;
  const out = [];
  for (const p of parts) {
    const mm = /^"([^"]*)"$/.exec(p) || /^'([^']*)'$/.exec(p);
    if (!mm) return null;
    out.push(mm[1]);
  }
  return out;
}

test('the six direct enums match member-for-member', () => {
  // Each pair was diffed programmatically; these assertions pin the result so a later edit to
  // either side fails here instead of silently changing what the model may pass.
  const cases = [
    ['GrepTool', 'GrepTool.ts', 'output_mode', ['content', 'files_with_matches', 'count']],
    ['NotebookEditTool', 'NotebookEditTool.ts', 'cell_type', ['code', 'markdown']],
    ['NotebookEditTool', 'NotebookEditTool.ts', 'edit_mode', ['replace', 'insert', 'delete']],
    ['SendFeedbackTool', 'SendFeedbackTool.ts', 'type', null],
  ];
  for (const [dir, file, field, expected] of cases) {
    const src = read(TOOLS, dir, file);
    const m = new RegExp(field + ":\\s*z\\s*\\n?\\s*\\.enum\\(\\[([^\\]]+)\\]\\)").exec(src);
    assert.ok(m, `${dir}.${field} is no longer a literal z.enum`);
    if (expected) {
      const actual = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      assert.deepEqual(actual, expected, `${dir}.${field} members changed`);
    }
  }
});

test('SendFeedback.failure_mode keeps all 16 contract members', () => {
  // Written in R412 by copying the contract. A single dropped member would be invisible: the field
  // is optional, so nothing fails when a category becomes unreachable.
  //
  // Extraction note: slicing from `failure_mode?` to a fixed offset pulls in the NEXT member's
  // literals. The first version of this test did that and wrongly reported type's values
  // (code_edit, debug, explain, ...) as missing from failure_mode. Members are parsed structurally.
  const official = literalsOf(officialMembers('SendFeedbackInput').failure_mode);
  assert.ok(official, 'failure_mode is no longer a closed set in the contract');
  assert.equal(official.length, 16, 'the contract changed size');

  const ccb = read(TOOLS, 'SendFeedbackTool', 'SendFeedbackTool.ts');
  const m = /failure_mode:\s*z\s*\n?\s*\.enum\(\[([\s\S]*?)\]\)/.exec(ccb);
  assert.ok(m, 'failure_mode is no longer a literal z.enum on the CCB side');
  const actual = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);

  assert.deepEqual(official.filter((v) => !actual.includes(v)), [],
    'failure_mode is missing contract members');
  assert.deepEqual(actual.filter((v) => !official.includes(v)), [],
    'failure_mode has members the contract does not define');
});

test('SendFeedback.task_category matches all 8 members', () => {
  const official = literalsOf(officialMembers('SendFeedbackInput').task_category);
  assert.ok(official, 'task_category is no longer a closed set');
  assert.equal(official.length, 8, 'the contract changed size');

  const ccb = read(TOOLS, 'SendFeedbackTool', 'SendFeedbackTool.ts');
  const m = /task_category:\s*z\s*\n?\s*\.enum\(\[([\s\S]*?)\]\)/.exec(ccb);
  assert.ok(m, 'task_category is no longer a literal z.enum');
  const actual = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(official.filter((v) => !actual.includes(v)), [],
    'task_category is missing contract members');
  assert.deepEqual(actual.filter((v) => !official.includes(v)), [],
    'task_category has members the contract does not define');
});

test('Agent.mode resolves through PERMISSION_MODES to exactly the contract set', () => {
  // Indirect: `permissionModeSchema()` -> `z.enum(PERMISSION_MODES)` -> EXTERNAL + 'auto'.
  // Indirection is where a value set drifts without anyone noticing, so it is resolved explicitly.
  const perms = read(SRC, 'src', 'types', 'permissions.ts');
  const ext = /EXTERNAL_PERMISSION_MODES = \[(.*?)\]/s.exec(perms);
  assert.ok(ext, 'EXTERNAL_PERMISSION_MODES moved');
  const external = [...ext[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);

  const internal = /INTERNAL_PERMISSION_MODES = \[(.*?)\]/s.exec(perms);
  assert.ok(internal, 'INTERNAL_PERMISSION_MODES moved');
  const extra = [...internal[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  const effective = [...new Set([...external, ...extra])].sort();

  assert.deepEqual(effective,
    ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
    'the effective permission-mode set no longer matches the contract');

  // And the field really uses that schema. The CONTRACT name is `mode`; the CCB field is spelled
  // `permissionMode`, and it lives in loadAgentsDir.ts rather than AgentTool.tsx — the agent-def
  // loader is what validates the mode, so that is where the enum belongs.
  const loader = read(TOOLS, 'AgentTool', 'loadAgentsDir.ts');
  assert.match(loader, /permissionMode:\s*z\.enum\(PERMISSION_MODES\)\.optional\(\)/,
    'Agent.mode no longer uses PERMISSION_MODES');
  const official = literalsOf(officialMembers('AgentInput').mode);
  assert.ok(official, 'AgentInput.mode is no longer a closed set');
  assert.deepEqual(official.slice().sort(), effective,
    'the contract mode set changed');
});

test('Agent.effort lists exactly the five contract levels', () => {
  const effort = read(SRC, 'src', 'utils', 'effort.ts');
  const m = /EFFORT_LEVELS = \[(.*?)\]/s.exec(effort);
  assert.ok(m, 'EFFORT_LEVELS moved');
  const values = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(values, ['low', 'medium', 'high', 'xhigh', 'max'],
    'EFFORT_LEVELS no longer matches the contract');
});

test('Agent.isolation is NARROWER in CCB, and that is deliberate', () => {
  // Contract allows worktree | remote. CCB restricts to worktree unless USER_TYPE === 'ant'.
  // A narrower set is safe (the model cannot ask for something unsupported); a WIDER one would not.
  const agent = read(TOOLS, 'AgentTool', 'AgentTool.tsx');
  const m = /process\.env\.USER_TYPE === 'ant'\s*\n?\s*\?\s*z\.enum\(\['worktree', 'remote'\]\)\s*\n?\s*:\s*z\.enum\(\['worktree'\]\)/.exec(agent);
  assert.ok(m, 'the isolation conditional changed: re-derive whether CCB is still narrower');
});

test('Agent.model is the one real divergence: the contract has a 4th member', () => {
  // The contract declares four literals. CCB declares three — `fable` is absent from the entire
  // repository. This is the SAME defect R406 hit when it tried to widen the enum and got
  // TS2345/TS2322, forcing a revert. The independent enum comparison reproduces that finding.
  //
  // Practical effect: a caller asking for `fable` is rejected by the schema, so the model can never
  // select it, even though the official tool accepts it.
  const official = literalsOf(officialMembers('AgentInput').model);
  assert.ok(official, 'AgentInput.model is no longer a closed set');
  assert.deepEqual(official, ['sonnet', 'opus', 'haiku', 'fable'],
    'the contract model enum changed: re-derive this divergence');

  const agent = read(TOOLS, 'AgentTool', 'AgentTool.tsx');
  // Scope to the model field's own chain. Scanning the whole file finds OTHER fields' z.enum calls
  // (effort and permissionMode live here too) and would report a fix that did not happen.
  const m = /model:\s*z\s*\n\s*\.enum\(\[([^\]]+)\]\)\s*\n\s*\.optional\(\)/.exec(agent);
  assert.ok(m, 'the Agent model schema is no longer a literal enum');
  const ccbValues = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);

  const missing = official.filter((v) => !ccbValues.includes(v));
  assert.deepEqual(missing, ['fable'],
    'the divergence changed: if `fable` was added, delete this test and the R406 note');

  // Independently confirm the member is absent from the whole source tree, not just this field —
  // a value that exists elsewhere but not here would mean something different.
  const root = path.join(SRC, 'src');
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      if (/['"]fable['"]/.test(fs.readFileSync(full, 'utf8'))) found.push(full);
    }
  };
  walk(root);
  assert.deepEqual(found, [], '`fable` appeared in src/: re-derive whether the enum can now include it');
});

test('no other tool declares an enum the contract does not define', () => {
  // A member the contract lacks would let the model request something the real tool rejects.
  // Checked for the tools implemented in this reconstruction that declare literal enums.
  const known = {
    GrepTool: ['output_mode'],
    NotebookEditTool: ['cell_type', 'edit_mode'],
    SendFeedbackTool: ['failure_mode', 'task_category', 'type'],
  };
  for (const [dir, fields] of Object.entries(known)) {
    const d = path.join(TOOLS, dir);
    const files = fs.readdirSync(d).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    const blob = files.map((f) => read(d, f)).join('\n');
    for (const field of fields) {
      assert.ok(blob.includes(field + ': z') || blob.includes(field + ':'),
        `${dir} lost ${field}`);
    }
  }
});
