// R441: OUTPUT-side enum values — 5 comparable fields, all match; 4 fields belong to tools that do
// not exist in this reconstruction.
//
// THE COVERAGE MISTAKE, REPEATED AND CAUGHT
//   The first pass scanned a hardcoded list of 18 tool pairs and found 3 closed-set output fields,
//   all matching. That looked like a finished result. The contract actually has 37 Output interfaces
//   and 9 closed-set fields — so 3 of 9 was being reported as "all".
//
//   R437 hit exactly this on the input side (6 found, 10 real). Doing it again one round later is
//   the point worth recording: a scan restricted to a hand-written pair list measures that list, not
//   the contract.
//
// THE 9 FIELDS AND THEIR FATES
//   FileWrite.type            MATCH
//   Grep.mode                 MATCH
//   NotebookEdit.cell_type    MATCH
//   ExitWorktree.action       MATCH
//   PushNotification.disabledReason  MATCH
//   ReportFindings.level      tool absent from CCB
//   OfferChromeSetup.outcome  tool absent from CCB
//   Workflow.status           tool absent from CCB
//   Workflow.taskType         tool absent from CCB
//
//   "Tool absent" is not a mismatch. Four of these are among the 10 official tools this
//   reconstruction does not implement (R417), so there is nothing to compare.
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

/** Closed-set literal values of one official Output field, or null. */
function officialEnum(iface, field) {
  const dts = read(DTS);
  const m = new RegExp('export interface ' + iface + 'Output\\b[^{]*\\{').exec(dts);
  assert.ok(m, iface + 'Output is gone');
  const s = m.index + m[0].length;
  let depth = 1;
  let i = s;
  while (i < dts.length && depth) {
    if (dts[i] === '{') depth += 1;
    else if (dts[i] === '}') depth -= 1;
    i += 1;
  }
  const body = dts.slice(s, i - 1);

  let memberDepth = 0;
  let name = null;
  let parts = [];
  let captured = null;
  const flush = () => {
    if (name === field && captured === null) captured = parts.join(' ');
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

  if (!captured) return null;
  const flat = captured.replace(/\s+/g, ' ').trim().replace(/;$/, '').replace(/^\|\s*/, '');
  const bits = flat.split('|').map((p) => p.trim());
  if (bits.length < 2) return null;
  const vals = [];
  for (const b of bits) {
    const mm = /^"([^"]*)"$/.exec(b) || /^'([^']*)'$/.exec(b);
    if (!mm) return null;
    vals.push(mm[1]);
  }
  return vals;
}

/** The CCB field's z.enum members, or null when absent / not an enum. */
function ccbEnum(toolDir, field) {
  const d = path.join(TOOLS, toolDir);
  if (!fs.existsSync(d)) return 'TOOL_ABSENT';
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
    const t = read(TOOLS, toolDir, f);
    const at = t.indexOf('const outputSchema = lazySchema(');
    if (at < 0) continue;
    const rest = t.slice(at);
    const om = /z\.(?:strictObject|object)\(\{/.exec(rest);
    if (!om) continue;
    const brace = om.index + om[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = brace; i < rest.length; i += 1) {
      if (rest[i] === '{') depth += 1;
      else if (rest[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const body = rest.slice(brace + 1, end);
    for (const chunk of body.split(/\r?\n(?= {4}(?:[A-Za-z_$][\w$]*|'[^']+')\??:)/)) {
      const mm = /^\s*([A-Za-z_$][\w$]*)\??:/.exec(chunk);
      if (!mm || mm[1] !== field) continue;
      const em = /z\s*\.\s*enum\(\s*\[([^\]]*)\]\)/.exec(chunk);
      if (!em) return null;
      return [...em[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    }
  }
  return null;
}

test('the five comparable output enums match member-for-member', () => {
  const cases = [
    ['FileWrite', 'FileWriteTool', 'type'],
    ['Grep', 'GrepTool', 'mode'],
    ['NotebookEdit', 'NotebookEditTool', 'cell_type'],
    ['ExitWorktree', 'ExitWorktreeTool', 'action'],
    ['PushNotification', 'PushNotificationTool', 'disabledReason'],
  ];
  for (const [iface, dir, field] of cases) {
    const off = officialEnum(iface, field);
    assert.ok(off, `${iface}.${field} is no longer a closed set in the contract`);
    const ccb = ccbEnum(dir, field);
    assert.notEqual(ccb, 'TOOL_ABSENT', `${dir} disappeared: re-derive whether this row is comparable`);
    assert.ok(Array.isArray(ccb), `${iface}.${field} is no longer a literal z.enum on the CCB side`);

    assert.deepEqual(off.filter((v) => !ccb.includes(v)), [],
      `${iface}.${field} is missing contract values`);
    assert.deepEqual(ccb.filter((v) => !off.includes(v)), [],
      `${iface}.${field} has values the contract does not define`);
  }
});

test('the four un-implemented tools are absent, not mismatched', () => {
  // Reporting "tool absent" as a mismatch would inflate the gap count with things that cannot be
  // compared. These are among the 10 official tools R417 recorded as not implemented.
  for (const dir of ['ReportFindingsTool', 'OfferChromeSetupTool', 'WorkflowTool']) {
    assert.equal(fs.existsSync(path.join(TOOLS, dir)), false,
      dir + ' now exists: its output enum becomes comparable, update this test and the evidence');
  }
  // Their contract fields still exist and are still closed sets — the values are not in dispute,
  // there is simply nothing on the CCB side to compare them against.
  assert.deepEqual(officialEnum('ReportFindings', 'level')?.length, 5);
  assert.deepEqual(officialEnum('OfferChromeSetup', 'outcome')?.length, 3);
  assert.deepEqual(officialEnum('Workflow', 'status')?.length, 2);
  assert.deepEqual(officialEnum('Workflow', 'taskType')?.length, 2);
});

test('the contract really has 9 closed-set output fields, not 3', () => {
  // The coverage guard. The first pass scanned 18 hand-picked tool pairs and found 3; the contract
  // has 37 Output interfaces. A scan limited to a pair list measures the list, not the contract.
  const dts = read(DTS);
  const ifaces = [...dts.matchAll(/export interface (\w+Output)\b/g)].map((m) => m[1]);
  assert.ok(ifaces.length >= 35,
    'the contract now has only ' + ifaces.length + ' Output interfaces: re-derive the coverage claim');

  let closed = 0;
  for (const iface of ifaces) {
    const m = new RegExp('export interface ' + iface + '\\b[^{]*\\{').exec(dts);
    if (!m) continue;
    const s = m.index + m[0].length;
    let depth = 1;
    let i = s;
    while (i < dts.length && depth) {
      if (dts[i] === '{') depth += 1;
      else if (dts[i] === '}') depth -= 1;
      i += 1;
    }
    const body = dts.slice(s, i - 1);
    // Count members whose type is entirely string literals.
    for (const mm of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\??:\s*([^;]+);/gm)) {
      const flat = mm[2].replace(/\s+/g, ' ').trim().replace(/^\|\s*/, '');
      const bits = flat.split('|').map((p) => p.trim());
      if (bits.length > 1 && bits.every((b) => /^"[^"]*"$/.test(b) || /^'[^']*'$/.test(b))) {
        closed += 1;
      }
    }
  }
  assert.ok(closed >= 8,
    'only ' + closed + ' closed-set output fields found: the count dropped from 9, re-derive');
});
