// R433: FileWrite reports userModified — a value it already received and discarded.
//
// THE CENSUS NEEDED CORRECTING
//   The gap list said "FileWrite.userModified missing". Investigating showed the field is already
//   implemented in the sibling tool:
//
//       FileEditTool.ts:  const { filePath, userModified, replaceAll } = data
//                         userModified: userModified ?? false
//
//   sourced from `ToolUseContext.userModified`, which `toolExecution.ts:1262` fills from
//   `permissionDecision.userModified`. So FileWrite was not missing a mechanism — it was reading a
//   context object that already contained the value and simply not forwarding one field.
//
// WHY THE MEANING MATTERS
//   `userModified` records that the user edited the proposed operation before approving it. A write
//   the user changed is a different event from one approved as-is; the contract exposes the
//   difference so a client can distinguish them.
//
// WHAT WAS DELIBERATELY NOT DONE
//   `staged` has ZERO occurrences in either file-tool directory, and no staging-detection helper
//   exists anywhere — it would need `git status` / `git diff --cached` probing on every write. That
//   is real I/O cost rather than a field addition, so it stays open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const WRITE = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'FileWriteTool',
  'FileWriteTool.ts');
const EDIT = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'FileEditTool',
  'FileEditTool.ts');
const EXEC = path.join(SRC, 'src', 'services', 'tools', 'toolExecution.ts');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const write = () => fs.readFileSync(WRITE, 'utf8');

function code() {
  return write()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the contract keeps userModified optional on FileWriteOutput', () => {
  const dts = fs.readFileSync(DTS, 'utf8');
  const at = dts.indexOf('export interface FileWriteOutput');
  assert.ok(at > 0, 'FileWriteOutput is gone');
  const open = dts.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < dts.length; i += 1) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = dts.slice(open + 1, end);
  assert.match(body, /userModified\?: boolean/, 'userModified is no longer optional');
});

test('the source of truth is still the permission decision, via the tool context', () => {
  // If this link breaks, the field would report a value nobody computes.
  const exec = fs.readFileSync(EXEC, 'utf8');
  assert.match(exec, /userModified: permissionDecision\.userModified \?\? false/,
    'toolExecution no longer derives userModified from the permission decision');

  // FileEdit reports it from the same context field — that is the precedent this change follows.
  const edit = fs.readFileSync(EDIT, 'utf8');
  assert.match(edit, /userModified: userModified \?\? false/,
    'FileEdit no longer reports userModified: re-derive whether FileWrite should keep doing so');
});

test('FileWrite destructures the context field it already receives', () => {
  const c = code();
  const sigAt = c.indexOf('dynamicSkillDirTriggers,');
  assert.ok(sigAt > 0, 'the call signature changed shape');
  const after = c.slice(sigAt, sigAt + 220);
  assert.ok(after.includes('userModified,'),
    'FileWrite does not destructure userModified from its context');
});

test('BOTH data branches report it — create and update', () => {
  // A field present in only one branch would silently vanish for new files.
  const c = code();
  const spreads = (c.match(/\.\.\.\(userModified !== undefined \? \{ userModified \} : \{\}\)/g) || []).length;
  assert.equal(spreads, 2,
    'expected userModified in both the create and update branches, found ' + spreads);

  // And each branch is genuinely present.
  assert.match(c, /type: 'update' as const/, 'the update branch is gone');
  assert.match(c, /type: 'create' as const/, 'the create branch is gone');
});

test('the field is omitted rather than defaulted, so "unknown" stays unknown', () => {
  const c = code();
  // FileEdit defaults to false because it is an established contract there. For FileWrite the
  // context value can be genuinely absent (SDK/QueryEngine do not track it), and reporting `false`
  // would assert the user did NOT modify something nobody observed.
  assert.ok(!/userModified: userModified \?\? false/.test(c),
    'FileWrite now defaults userModified to false, which claims an observation it does not have');
  assert.match(c, /userModified !== undefined \? \{ userModified \} : \{\}/,
    'the conditional spread changed: re-derive the absent-value behaviour');
});

test('the schema declares userModified as optional', () => {
  const c = code();
  const at = c.indexOf('const outputSchema');
  assert.ok(at > 0, 'FileWriteTool lost its outputSchema');
  const end = c.indexOf('type OutputSchema', at);
  const seg = c.slice(at, end > 0 ? end : at + 2400);
  assert.match(seg, /userModified: z[\s\S]{0,120}?\.optional\(\)/,
    'userModified is not declared optional in the schema');
});

test('staged stays absent, and the reason is still true', () => {
  const c = code();
  assert.ok(!/staged/.test(c), 'FileWrite gained `staged` without a staging source');
  // No helper exists to consult, which is why this one was not attempted.
  const edit = fs.readFileSync(EDIT, 'utf8');
  assert.ok(!/staged/.test(edit), 'FileEdit gained `staged`: a staging source may now exist');
});

test('the adopted bundle carries the field', () => {
  const { text } = findChunk('Whether the user modified the content before approving the write');
  assert.ok(text.includes('userModified'), 'userModified is missing from the built chunk');
});
