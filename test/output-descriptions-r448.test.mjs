// R448: output-field descriptions — and the first real defect this dimension found.
//
// WHY THIS ROUND WAS NOT THE MIRROR IMAGE OF R447
//   R447 compared input-field descriptions: 76 fields, 0 real divergences. Doing the same for outputs
//   was expected to be mechanical. It was not, for a reason worth recording:
//
//       INPUT  interfaces: 155 fields, 152 documented  (98.1%)
//       OUTPUT interfaces: 169 fields, 109 documented  (64.5%)
//       Eight output interfaces carry ZERO docs — the largest is GrepOutput with 11 fields.
//
//   So a third of output fields have no official prose to compare against. The first attempt's
//   self-check failed on GrepOutput.mode (no doc at all) and, because the self-check refused to
//   report, the run produced nothing instead of 11 false "missing description" findings.
//
// THE DEFECT IT FOUND
//   Glob.totalMatches was declared as a NUMBER in R427 and described as
//
//       'Every path that matched, before the result limit was applied'
//
//   "Every path" describes a list; the value is a count.`filenames` is the list. Name and type were
//   both correct, so R419 and R436 could never have caught it — only the prose comparison could.
//
//   The contract says: "Total number of matching files before truncation. A lower bound when
//   countIsComplete is false. Absent on results persisted by CLI versions predating this field."
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

const KEY = String.raw`(?:[A-Za-z_$][\w$]*|"[^"]+"|'[^']+')`;

function officialMembers(iface) {
  const dts = read(DTS);
  const m = new RegExp('export interface ' + iface + '\\b[^{]*\\{').exec(dts);
  if (!m) return null;
  const s = m.index + m[0].length;
  let depth = 1;
  let i = s;
  while (i < dts.length && depth) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') depth -= 1;
    i += 1;
  }
  const body = dts.slice(s, i - 1);

  const events = [];
  let memberDepth = 0;
  let inDoc = false;
  for (const line of body.split('\n')) {
    const bare = line.trim();
    if (memberDepth === 0) {
      if (inDoc) {
        if (bare.endsWith('*/')) { events.push(['doc', bare.slice(0, -2).trim()]); inDoc = false; }
        else events.push(['doc', bare.replace(/^\*+/, '').trim()]);
        continue;
      }
      if (bare.startsWith('/**')) {
        if (bare.endsWith('*/')) events.push(['doc', bare.slice(3, -2).trim()]);
        else { inDoc = true; events.push(['doc', bare.slice(3).trim()]); }
        continue;
      }
      const mm = new RegExp('^(' + KEY + ')\\??\\s*:').exec(bare);
      if (mm) events.push(['member', mm[1].replace(/^["']|["']$/g, ''), bare.slice(mm[0].length).trim()]);
      else events.push(['type', bare]);
    } else {
      events.push(['type', bare]);
    }
    memberDepth += (line.match(/\{/g) || []).length + (line.match(/\[/g) || []).length;
    memberDepth -= (line.match(/\}/g) || []).length + (line.match(/\]/g) || []).length;
    if (memberDepth < 0) memberDepth = 0;
  }

  const out = {};
  let docRun = [];
  for (const ev of events) {
    if (ev[0] === 'doc') docRun.push(ev[1]);
    else if (ev[0] === 'member') { out[ev[1]] = docRun.join(' ').trim(); docRun = []; }
  }
  return out;
}

test('output documentation is materially sparser than input documentation', () => {
  // The asymmetry that made this round different from R447. If it ever evens out, an output
  // description comparison becomes much more informative and this test should be revisited.
  const dts = read(DTS);
  const ifaces = [...dts.matchAll(/export interface (\w+)\b/g)].map((m) => m[1]);
  const cover = (suffix) => {
    let total = 0;
    let documented = 0;
    for (const n of ifaces.filter((x) => x.endsWith(suffix))) {
      const ms = officialMembers(n);
      if (!ms) continue;
      total += Object.keys(ms).length;
      documented += Object.values(ms).filter((d) => d).length;
    }
    return { total, documented };
  };
  const inp = cover('Input');
  const out = cover('Output');
  assert.ok(inp.total > 140, 'input field count changed: ' + inp.total);
  assert.ok(out.total > 150, 'output field count changed: ' + out.total);
  assert.ok(inp.documented / inp.total > 0.95,
    'input docs thinned out: ' + inp.documented + '/' + inp.total);
  assert.ok(out.documented / out.total < 0.80,
    'output docs filled in (' + out.documented + '/' + out.total + '): re-run the comparison, more '
    + 'fields are now eligible');
});

test('GrepOutput is the largest fully undocumented output interface', () => {
  // This is the shape that stopped the first attempt. Recorded so the next reader knows why a
  // straightforward output comparison yields no text for Grep.
  const ms = officialMembers('GrepOutput');
  assert.ok(ms, 'GrepOutput is gone');
  assert.ok(Object.keys(ms).length >= 10, 'GrepOutput shrank to ' + Object.keys(ms).length + ' fields');
  const documented = Object.values(ms).filter((d) => d).length;
  assert.equal(documented, 0,
    'GrepOutput now has ' + documented + ' documented fields: it becomes comparable, update the note');
});

test('Glob.totalMatches describes a COUNT, not a list of paths', () => {
  // The defect R448 found. The field is a number; the old text said "Every path that matched".
  const glob = read(TOOLS, 'GlobTool', 'GlobTool.ts');
  const m = /totalMatches:\s*z\s*\n?\s*\.number\(\)[\s\S]{0,200}?\.describe\(\s*'([^']*)'/.exec(glob);
  assert.ok(m, 'Glob.totalMatches is no longer z.number() with a describe');
  const doc = m[1];

  assert.ok(!/every path/i.test(doc),
    'the description again calls a number a list: ' + doc);
  assert.match(doc, /total number of matching files/i,
    'the description no longer states it is a count');
  assert.match(doc, /lower bound/i,
    'the description dropped the lower-bound caveat, which the contract states explicitly');
});

test('the contract wording for Glob.totalMatches still supports the fix', () => {
  // Guard the basis of the correction, so a contract change does not leave the fix unexplained.
  const dts = read(DTS);
  assert.match(dts, /total number of matching files before truncation/i,
    'the contract no longer says this; re-derive the correction');
  assert.match(dts, /A lower bound when countIsComplete is false/,
    'the contract no longer states the lower-bound caveat');
});

test('the corrected description reached the adopted bundle', () => {
  const { text } = findChunk('Total number of matching files before truncation');
  assert.ok(text.includes('totalMatches'), 'totalMatches is missing from the built chunk');
  // And the wrong text is gone from the bundle, not merely from source.
  assert.ok(!text.includes('Every path that matched, before the result limit'),
    'the old wrong description is still in the bundle');
});

test('the 70 aligned output fields stay aligned — spot-check the ones with prose', () => {
  // A small spot-check so a silent divergence cannot hide behind the coverage asymmetry.
  const glob = officialMembers('GlobOutput');
  assert.ok(glob, 'GlobOutput is gone');
  const expectations = [
    ['numFiles', 'number of file'],
    ['filenames', 'array of file paths'],
    ['truncated', 'truncat'],
  ];
  for (const [field, needle] of expectations) {
    assert.ok(glob[field], 'GlobOutput.' + field + ' missing');
    assert.ok(glob[field].toLowerCase().includes(needle),
      `GlobOutput.${field} doc changed: "${glob[field]}"`);
  }
});
