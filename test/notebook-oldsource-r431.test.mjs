// R431: NotebookEdit reports old_source — captured before the edit destroys it.
//
// THE CONTRACT SAYS TWO THINGS
//   "The previous cell source (replace/delete only). Enables cell-relative diff rendering without
//    re-reading the notebook."
//
//   1. replace and delete have a previous source; insert does not. The field must be ABSENT for an
//      insert, not an empty string — `old_source: ''` would claim the cell used to be empty.
//   2. The value has to be read before the mutation. Both branches overwrite it:
//          replace:  targetCell.source = new_source
//          delete:   notebook.cells.splice(cellIndex, 1)
//      Reading afterwards returns the new content, or nothing.
//
//   A third case comes from the tool's own retry logic: a `replace` whose index is one past the end
//   is converted to `insert`. That conversion has no previous cell, so it must not report one
//   either — and because the capture keys off the CONVERTED mode, it naturally does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChunk } from './_ccb-dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const TOOL = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'NotebookEditTool',
  'NotebookEditTool.ts');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const src = () => fs.readFileSync(TOOL, 'utf8');

/** Source with comments removed: assertions must read code, not prose. */
function code() {
  return src()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the contract keeps old_source optional and documents the replace/delete restriction', () => {
  const dts = fs.readFileSync(DTS, 'utf8');
  const at = dts.indexOf('export interface NotebookEditOutput');
  assert.ok(at > 0, 'NotebookEditOutput is gone');
  const open = dts.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < dts.length; i += 1) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = dts.slice(open + 1, end);
  assert.match(body, /old_source\?: string/,
    'old_source is no longer optional in the contract');
  assert.ok(/replace\/delete only/.test(body),
    'the contract no longer restricts old_source to replace/delete: re-derive the insert case');
});

test('the source is captured BEFORE the mutating branches', () => {
  const c = code();

  const captureAt = c.indexOf('let oldSource: string | undefined');
  assert.ok(captureAt > 0, 'the capture declaration is gone');

  const replaceAt = c.indexOf('targetCell.source = new_source');
  const deleteAt = c.indexOf('notebook.cells.splice(cellIndex, 1)');
  assert.ok(replaceAt > 0, 'the replace mutation moved');
  assert.ok(deleteAt > 0, 'the delete mutation moved');

  assert.ok(captureAt < replaceAt,
    'old_source is captured after the replace mutation: it would return the NEW source');
  assert.ok(captureAt < deleteAt,
    'old_source is captured after the delete mutation: the cell is already gone');
});

test('the capture is skipped for insert, and handles array-typed sources', () => {
  const c = code();
  // Keyed off the CONVERTED edit_mode, which is what makes the replace-past-end case fall through
  // to no old_source.
  assert.match(c, /if \(edit_mode !== 'insert'\) \{/,
    'the capture no longer excludes insert');
  // Jupyter allows `source` as string or string[]; joining keeps the type a single string.
  assert.match(c, /Array\.isArray\(existing\.source\)/,
    'the array-form source is not handled: some notebooks store source as string[]');
  assert.match(c, /existing\.source\.join\(''\)/,
    'the array-form source is no longer joined');
});

test('the success path reports old_source conditionally', () => {
  const c = code();
  assert.match(c, /\.\.\.\(oldSource !== undefined \? \{ old_source: oldSource \} : \{\}\)/,
    'old_source is not conditionally spread into the data object');
  // No empty-string fallback, which would assert a false fact.
  assert.ok(!/old_source:\s*oldSource\s*\?\?/.test(c),
    'old_source falls back to a default instead of being omitted');
  assert.ok(!/old_source:\s*''/.test(c),
    "old_source is defaulted to an empty string: that claims the cell used to be empty");
});

test('the error paths do NOT report old_source', () => {
  // A failed edit changed nothing, so there is no previous source to describe. The catch blocks
  // build their own data objects; neither should gain the field.
  const c = code();
  const catchAt = c.indexOf('} catch (error) {');
  assert.ok(catchAt > 0, 'the catch block moved');
  const tail = c.slice(catchAt);
  assert.ok(!/old_source/.test(tail),
    'a catch block reports old_source: a failed edit has no previous source to report');
});

test('the schema declares old_source as optional', () => {
  const c = code();
  const at = c.indexOf('const outputSchema');
  assert.ok(at > 0, 'NotebookEditTool lost its outputSchema');
  const end = c.indexOf('type OutputSchema', at);
  const seg = c.slice(at, end > 0 ? end : at + 2400);
  assert.match(seg, /old_source: z[\s\S]{0,400}?\.optional\(\)/,
    'old_source is not declared optional in the schema');
});

test('the adopted bundle carries the field', () => {
  const { text } = findChunk('The previous cell source (replace/delete only)');
  assert.ok(text.includes('old_source'), 'old_source is missing from the built chunk');
});
