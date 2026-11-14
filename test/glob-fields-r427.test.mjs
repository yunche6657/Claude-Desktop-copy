// R427: Glob's three missing output fields, and the sources behind them.
//
// THE CONTRACT
//   official GlobOutput      CCB before R427
//     durationMs  ✓            durationMs
//     numFiles    ✓            numFiles
//     filenames   ✓            filenames
//     truncated   ✓            truncated
//     totalMatches?      ✗
//     countIsComplete?   ✗
//     timedOut?          ✗
//
// WHY THIS IS THE SAME DEFECT AS R424, ONE CALLER OVER
//   `glob()` called `ripGrep(args, searchDir, abortSignal)` and dropped the timeout, so a listing
//   cut short looked exactly like a complete one. `totalMatches` was worse than missing: it was
//   already computed (`absolutePaths.length`, before the limit slice) and then discarded.
//
//   The three fields are not cosmetic:
//     totalMatches    — makes "exactly 100 matches" distinguishable from "at least 100".
//     countIsComplete — says the count is a lower bound rather than a total.
//     timedOut        — says why the listing is short.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', '.tmp', 'ccb-src');
const GLOB = path.join(SRC, 'src', 'utils', 'glob.ts');
const TOOL = path.join(SRC, 'packages', 'builtin-tools', 'src', 'tools', 'GlobTool', 'GlobTool.ts');
const DTS = path.resolve(ROOT, '..', '.tmp', 'cc-contract', 'package', 'sdk-tools.d.ts');

const globSrc = () => fs.readFileSync(GLOB, 'utf8');
const toolSrc = () => fs.readFileSync(TOOL, 'utf8');

test('the official contract still has the three optional fields', () => {
  const dts = fs.readFileSync(DTS, 'utf8');
  const at = dts.indexOf('export interface GlobOutput');
  assert.ok(at > 0, 'GlobOutput interface is gone');
  const open = dts.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < dts.length; i += 1) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = dts.slice(open + 1, end);
  for (const f of ['totalMatches?', 'countIsComplete?', 'timedOut?']) {
    assert.ok(body.includes(f), 'the contract lost ' + f + ': re-derive which fields to report');
  }
});

test('glob() captures the timeout instead of dropping it', () => {
  const s = globSrc();
  // The callback that makes the signal observable.
  assert.match(s, /let timedOut = false/,
    'glob() no longer tracks a timeout: a truncated listing would look complete');
  assert.match(s, /ripGrep\(args, searchDir, abortSignal, \(\) => \{[\s\S]{0,60}?timedOut = true/,
    'the onTimeout callback is no longer passed to ripGrep');
});

test('glob() returns all three fields, and totalMatches comes from the pre-slice count', () => {
  const s = globSrc();
  for (const f of ['totalMatches', 'countIsComplete', 'timedOut']) {
    assert.match(s, new RegExp('\\b' + f + ':'), 'glob() does not return ' + f);
  }
  // The load-bearing detail: the count must be taken BEFORE `slice(offset, offset + limit)`,
  // otherwise it would just restate `files.length` and tell the caller nothing.
  const countAt = s.indexOf('totalMatches: absolutePaths.length');
  assert.ok(countAt > 0, 'totalMatches is not derived from absolutePaths.length');
  const sliceAt = s.search(/absolutePaths\.slice\(/);
  assert.ok(sliceAt > 0, 'the limit slice moved; re-derive the ordering claim');
  assert.ok(countAt > sliceAt,
    'totalMatches is computed before the slice, which means it came from a different source');
  // And it is the raw list length, not the sliced one.
  assert.ok(!/totalMatches:\s*files\.length/.test(s),
    'totalMatches now restates files.length, so it can never exceed the page size');
});

test('countIsComplete is the negation of the timeout', () => {
  const s = globSrc();
  assert.match(s, /countIsComplete: !timedOut/,
    'countIsComplete no longer reflects the timeout: a truncated count would look exact');
});

test('GlobTool threads all three into its output object', () => {
  const g = toolSrc();
  // Strip comments first. The header comment above the spreads names `timedOut: false` while
  // explaining why it is NOT emitted, and a raw text match cannot tell code from prose. This is
  // the fifth time in this session that an assertion matched a comment instead of code.
  const code = g
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.match(code, /const \{ files, truncated, totalMatches, countIsComplete, timedOut \} = await glob\(/,
    'GlobTool no longer destructures the new fields');

  // Conditional spreads: a normal listing must stay a four-field object.
  assert.match(code, /\.\.\.\(totalMatches !== files\.length \|\| truncated \? \{ totalMatches \} : \{\}\)/,
    'totalMatches is no longer omitted when it adds nothing');
  assert.match(code, /\.\.\.\(countIsComplete \? \{\} : \{ countIsComplete: false \}\)/,
    'countIsComplete is no longer conditional');
  assert.match(code, /\.\.\.\(timedOut \? \{ timedOut: true \} : \{\}\)/,
    'timedOut is no longer conditional');

  // No literal false, which would put noise on every ordinary call.
  assert.ok(!/timedOut: false/.test(code), 'a literal timedOut: false is being emitted');
  assert.ok(!/countIsComplete: true/.test(code), 'a literal countIsComplete: true is being emitted');
});

test('the schema declares all three as optional', () => {
  const g = toolSrc();
  const at = g.indexOf('const outputSchema');
  assert.ok(at > 0, 'GlobTool lost its outputSchema');
  const end = g.indexOf('type OutputSchema', at);
  const seg = g.slice(at, end > 0 ? end : at + 2400);

  for (const f of ['totalMatches', 'countIsComplete', 'timedOut']) {
    assert.ok(new RegExp('^\\s{4}' + f + ': z', 'm').test(seg),
      'the schema does not declare ' + f);
  }
  const optionals = (seg.match(/\.optional\(\)/g) || []).length;
  assert.equal(optionals, 3,
    'expected exactly the three new fields to be optional, found ' + optionals);
});

test('glob() still has exactly one caller, which is why changing its type was safe', () => {
  // If this ever grows, the widened return type needs re-checking against every caller.
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      const t = fs.readFileSync(full, 'utf8');
      if (/\bfrom 'src\/utils\/glob\.js'/.test(t) && /\bglob\(/.test(t)) files.push(full);
    }
  };
  walk(path.join(SRC, 'src'));
  walk(path.join(SRC, 'packages'));
  assert.equal(files.length, 1,
    'glob() gained a caller; re-check that the widened return type is handled: '
    + files.map((f) => path.relative(SRC, f)).join(', '));
  assert.ok(files[0].endsWith(path.join('GlobTool', 'GlobTool.ts')),
    'the single caller is no longer GlobTool');
});
