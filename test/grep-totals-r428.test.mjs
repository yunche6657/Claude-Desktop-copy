// R428: Grep reports totalFiles / totalLines — the PRE-pagination counts.
//
// THE NUMBER WAS ALREADY THERE
//   `applyHeadLimit` computed `items.length` to decide whether results were truncated, returned
//   only the slice, and dropped the length:
//
//       const sliced = items.slice(offset, offset + effectiveLimit)
//       const wasTruncated = items.length - offset > effectiveLimit
//       return { items: sliced, appliedLimit: wasTruncated ? effectiveLimit : undefined }
//
//   R428 returns it as `total`. Same shape of defect as R427's `totalMatches`: the value existed,
//   was used for a decision, and was not reported.
//
// THE TRAP THAT MADE THIS MORE THAN A FIELD ADD
//   Count mode summed `totalMatches` / `fileCount` AFTER `applyHeadLimit`, so those numbers
//   described the current page. Adding `totalFiles` from them would have been worse than leaving
//   the field out — the model would read a page count as the search's total.
//
// SCOPE OF THE CLAIM
//   Static only. `GrepTool` cannot be imported in this build (see test/greptool-boundary-r426), so
//   the wiring is asserted against source, not observed at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const GREP = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'GrepTool', 'GrepTool.ts');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const src = () => fs.readFileSync(GREP, 'utf8');

/** Source with comments removed: assertions must read code, not prose. */
function code() {
  return src()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the official contract declares both totals as optional', () => {
  const dts = fs.readFileSync(DTS, 'utf8');
  const at = dts.indexOf('export interface GrepOutput');
  assert.ok(at > 0, 'GrepOutput interface is gone');
  const open = dts.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < dts.length; i += 1) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = dts.slice(open + 1, end);
  assert.ok(body.includes('totalFiles?'), 'totalFiles is no longer optional in the contract');
  assert.ok(body.includes('totalLines?'), 'totalLines is no longer optional in the contract');
});

test('applyHeadLimit returns the unsliced length', () => {
  const c = code();
  assert.match(c, /\): \{ items: T\[\]; appliedLimit: number \| undefined; total: number \} \{/,
    'applyHeadLimit no longer declares `total` in its return type');
  assert.match(c, /const total = items\.length/,
    'the unsliced length is no longer captured');
  assert.match(c, /return \{ items: items\.slice\(offset\), appliedLimit: undefined, total \}/,
    'the unlimited-escape-hatch branch no longer returns total');
  assert.match(c, /appliedLimit: wasTruncated \? effectiveLimit : undefined,\s*total,/,
    'the main branch no longer returns total');
});

test('each output branch reports the total it actually computed', () => {
  const c = code();

  // Exactly one of the two names exists per branch. Putting both in all three would reference an
  // undefined name in two of them.
  assert.equal((c.match(/total: totalLines/g) || []).length, 1,
    'content mode should bind totalLines exactly once');
  assert.equal((c.match(/total: totalFiles/g) || []).length, 2,
    'count and files_with_matches modes should each bind totalFiles');

  assert.match(c, /\.\.\.\(totalLines !== undefined && \{ totalLines \}\)/,
    'content mode does not report totalLines');
  assert.equal((c.match(/\.\.\.\(totalFiles !== undefined && \{ totalFiles \}\)/g) || []).length, 2,
    'totalFiles should be reported by exactly the two file-counting modes');
});

test('count mode does NOT present page-scoped sums as totals', () => {
  const c = code();
  // The loop that produces totalMatches/fileCount must still walk the page, and the code must say
  // so — this is the trap that makes `totalFiles` necessary rather than redundant.
  assert.match(c, /for \(const line of finalCountLines\)/,
    'the count loop no longer walks the page: re-derive whether it can supply real totals');

  // The explanatory note lives IN A COMMENT, so it must be read from the raw source — asking the
  // comment-stripped text for a comment can never succeed. (Sixth time this session.)
  assert.match(src(), /CURRENT PAGE/,
    'the note distinguishing page counts from pre-pagination totals is gone');

  // And totalFiles must come from applyHeadLimit, not from fileCount.
  const c2 = c.replace(/\s+/g, ' ');
  assert.ok(!/totalFiles: fileCount/.test(c2),
    'totalFiles is now sourced from the page-scoped fileCount');
  assert.ok(!/totalLines: finalLines\.length/.test(c2),
    'totalLines is now sourced from the page');
});

test('the fields stay optional so a normal search carries no noise', () => {
  const c = code();
  const at = c.indexOf('const outputSchema');
  assert.ok(at > 0, 'GrepTool lost its outputSchema');
  const end = c.indexOf('type OutputSchema', at);
  const seg = c.slice(at, end > 0 ? end : at + 3000);

  for (const f of ['totalFiles', 'totalLines']) {
    assert.ok(new RegExp('^\\s{4}' + f + ': z', 'm').test(seg), 'schema does not declare ' + f);
  }
  // Both must be optional; a required number would force every caller to emit something.
  const block = seg.slice(seg.indexOf('totalFiles: z'), seg.indexOf('totalLines: z') + 200);
  assert.match(block, /totalFiles: z[\s\S]{0,80}?\.optional\(\)/,
    'totalFiles is not optional');
  assert.match(block, /totalLines: z[\s\S]{0,80}?\.optional\(\)/,
    'totalLines is not optional');
});
