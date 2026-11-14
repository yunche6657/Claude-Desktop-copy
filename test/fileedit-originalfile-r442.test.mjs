// R442: FileEdit.originalFile becomes nullable — closing the last output-type divergence.
//
// THE DECISION, AND WHY IT IS NOT A GUESS
//   Contract: `originalFile: string | null`      CCB was: `z.string()` (never null)
//
//   Two candidate fixes:
//     A. add .nullable() and pass null when there is no original content
//     B. keep the string, expose the already-computed `fileExists` flag instead
//
//   A won on three pieces of evidence:
//
//   1. FileWrite already does exactly this. Its contract says "(null for new files, or when the
//      previous content was too large to include)" and CCB's create branch sets originalFile: null.
//      So the pattern is established here, not invented.
//
//   2. FileEdit genuinely reaches a successful return with no original content. The path:
//        readFileForEdit() returns content: '' when the file is missing
//        getPatchForEdits() has an explicit empty-content branch
//        and `updatedFile = edit.old_string === '' ? edit.new_string : applyEditToFile(...)`
//        substitutes unconditionally for an empty old_string
//      i.e. "create a file by editing with an empty old_string" succeeds.
//
//   3. Option B would add a field the contract does not define — a divergence in the other
//      direction (an extra field rather than a missing one).
//
// WHAT THE TYPE CHECKER CAUGHT
//   Making the schema nullable immediately produced two TS errors in FileEditTool/UI.tsx, which had
//   called .split() on a value it assumed was a string. FileWriteTool/UI.tsx already used the
//   `?? undefined` idiom for the same reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOLS = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('the contract declares originalFile nullable on BOTH file tools', () => {
  // They are not independent: FileWrite's contract comment ("null for new files") is what showed
  // the pattern FileEdit was missing.
  const dts = read(DTS);
  for (const iface of ['FileEditOutput', 'FileWriteOutput']) {
    const at = dts.indexOf('export interface ' + iface);
    assert.ok(at > 0, iface + ' is gone');
    const open = dts.indexOf('{', at);
    let depth = 0;
    let end = -1;
    for (let i = open; i < dts.length; i += 1) {
      if (dts[i] === '{') depth += 1;
      else if (dts[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    assert.match(dts.slice(open + 1, end), /originalFile: string \| null/,
      iface + '.originalFile is no longer string | null');
  }
});

test('the schema is nullable and the value distinguishes absent from empty', () => {
  const types = read(TOOLS, 'FileEditTool', 'types.ts');
  const m = /originalFile: z\s*\n\s*\.string\(\)\s*\n\s*\.nullable\(\)/.exec(types);
  assert.ok(m, 'originalFile is not z.string().nullable()');

  const tool = read(TOOLS, 'FileEditTool', 'FileEditTool.ts');
  // The value must be conditional on fileExists — that is the whole distinction. A bare
  // `null` or a bare `originalFileContents` would each collapse the two cases.
  assert.match(tool, /originalFile: fileExists \? originalFileContents : null/,
    'originalFile does not distinguish a missing file from an empty one');
  assert.ok(!/originalFile: null,\s*\n/.test(tool),
    'originalFile is unconditionally null: an existing empty file would be misreported');
});

test('FileEdit can actually reach that state — the create-by-empty-edit path', () => {
  // Without this, the nullable branch would be dead code and the change would be the very defect
  // this session keeps removing: a field that can never carry its new value.
  const util = read(TOOLS, 'FileEditTool', 'utils.ts');
  // Empty content is explicitly supported.
  assert.match(util, /if \(\s*!fileContents\s*&&/, 'the empty-content branch is gone');
  // And an empty old_string substitutes without checking the file content.
  assert.match(util, /edit\.old_string === ''\s*\n?\s*\?\s*edit\.new_string/,
    'the unconditional substitution for an empty old_string is gone');

  // The reader substitutes '' rather than throwing when the file is missing.
  const tool = read(TOOLS, 'FileEditTool', 'FileEditTool.ts');
  assert.match(tool, /if \(isENOENT\(e\)\) \{[\s\S]{0,120}?content: ''/,
    'readFileForEdit no longer returns an empty string for a missing file');
});

test('the UI handles null the same way FileWrite already does', () => {
  const ui = read(TOOLS, 'FileEditTool', 'UI.tsx');
  assert.match(ui, /firstLine=\{originalFile\?\.split\('\\n'\)\[0\] \?\? null\}/,
    'firstLine is not null-safe: a create-by-edit would crash rendering');
  assert.match(ui, /fileContent=\{originalFile \?\? undefined\}/,
    'fileContent does not convert null to undefined');

  // The precedent this follows.
  const writeUi = read(TOOLS, 'FileWriteTool', 'UI.tsx');
  assert.match(writeUi, /fileContent=\{originalFile \?\? undefined\}/,
    'the FileWrite precedent changed: re-derive whether FileEdit should still mirror it');
});

test('FileWrite keeps its own null semantics unchanged', () => {
  // The fix touched only FileEdit; FileWrite's create branch must still be null.
  const tool = read(TOOLS, 'FileWriteTool', 'FileWriteTool.ts');
  const createSeg = tool.slice(tool.indexOf("type: 'create' as const"));
  const updateSeg = tool.slice(tool.indexOf("type: 'update' as const"));
  assert.match(createSeg.slice(0, 400), /originalFile: null/,
    'FileWrite create no longer reports null');
  assert.match(updateSeg.slice(0, 400), /originalFile: oldContent/,
    'FileWrite update no longer reports the previous content');
});

test('the adopted bundle carries the new description', () => {
  const { text } = findChunk('null when the file did not exist');
  assert.ok(text.includes('originalFile'), 'originalFile is missing from the built chunk');
});
