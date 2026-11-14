// R564: two groups off the mixed(tool+test) bucket, and both are "the same names standing for different facts".
//
// THE BUCKET R563 LEFT
//   `mixed(tool+test)` was the largest remaining class at 11 groups: a tool and its test carrying the same list in two
//   roles. The question was whether the test REUSES the tool's output (so they should not share) or both spell the same
//   setup twice (so a shared fixture is extractable). Only reading answers it, so this round read two.
//
// GROUP ONE — ['ToolInputSchemas','ToolOutputSchemas']
//   `tools/contract-union.cjs:24` is the only production declaration; R552 already made six callers import it. The other
//   two sites are the EXPECTED side of comparisons:
//
//       contract-tool-list-r443:125   assert.deepEqual(unions.sort(), ['ToolInputSchemas','ToolOutputSchemas'])
//                                     — asserts the CONTRACT has exactly these two union types
//       contract-union-r552:123       assert.deepEqual([...UNION_NAMES].sort(), [...])
//                                     — asserts the CONSTANT contains exactly them
//
//   Pointing either at `UNION_NAMES` would make it compare the constant with itself. So this group is already in the
//   shape R552 intended: one declaration, several independent checks on it.
//
// GROUP TWO — ['ListMcpResourcesTool','ReadMcpResourceTool']
//   Three sites, three different facts about the same two names:
//
//       tools/mcp-tool-gate.cjs:184        const RESOURCE = [...]      local, used two lines later, dropped
//                                          — "which tools appear once a resources server is present"
//       deferred-tools-r501:78             for (const name of [...]) assert.ok(d.deferred.includes(name))
//                                          — "both carry shouldDefer: true"
//       mcp-tool-gate-r504:75              assert.deepEqual(d.gained.sort(), [...])
//                                          — "both are what a resources server adds"
//
//   NOT shared, and the reason is specific: hoisting one constant would let a change to the gate silently rewrite what
//   two unrelated assertions test. The names coincide; the claims do not.
//
// PROGRESS
//       before R564   read 15 / 28
//       after         read 17 / 28
//
// WHAT THIS SAYS ABOUT THE BUCKET
//   Two of eleven read, both "do not share", for two DIFFERENT reasons — one is an expectation about a constant, the
//   other is three separate claims. So `mixed(tool+test)` is not one shape; the bucket's name describes file roles, not
//   the relationship between the copies. Expecting a single answer for the remaining nine would repeat R561's mistake.
//
// WHAT IS NOT CLAIMED
//   Not that the other nine are like these two. Not that `RESOURCE` in mcp-tool-gate is correctly scoped — only that
//   hoisting it is not the fix. Not that the two tests would never need to change together: they assert different
//   properties of the same two tools, so a rename SHOULD touch both, which is a reason to keep them separate and let
//   both fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { READ, sig } from '../tools/read-ledger.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'tools', 'read-ledger.cjs');

const runLedger = (args = []) => spawnSync(process.execPath, [LEDGER, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

test('both groups read this round are in the ledger', () => {
  for (const members of [['ToolInputSchemas', 'ToolOutputSchemas'],
    ['ListMcpResourcesTool', 'ReadMcpResourceTool']]) {
    const entry = READ.find((e) => sig(e.members) === sig(members));
    assert.ok(entry, `[${members.join(',')}] has no ledger entry`);
    assert.equal(entry.round, 564, `[${members.join(',')}] records round ${entry.round}`);
  }
});

test('the terminator group is one declaration plus independent checks', () => {
  const entry = READ.find((e) => e.members.includes('ToolInputSchemas'));
  assert.match(entry.verdict, /ONE DECLARATION \+ TWO EXPECTED VALUES/,
    'the verdict no longer names the shape');
  // And it is true: only contract-union.cjs declares it in production.
  const owners = [];
  for (const dir of ['tools', 'desktop']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.cjs')) continue;
      const src = fs.readFileSync(path.join(full, name), 'utf8');
      if (/new Set\(\['ToolInputSchemas'/.test(src)) owners.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(owners, ['tools/contract-union.cjs'],
    `the terminator list is declared in ${owners.join(', ')}`);
});

test('both terminator assertions are expected-value comparisons', () => {
  const sites = [
    ['test/contract-tool-list-r443.test.mjs', 125],
    ['test/contract-union-r552.test.mjs', 123],
  ];
  for (const [file, line] of sites) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')[line - 1] || '';
    assert.match(text, /assert\.deepEqual\(/, `${file}:${line} is not a comparison`);
    assert.match(text, /\['ToolInputSchemas',\s*'ToolOutputSchemas'\]/,
      `${file}:${line} does not carry the expected literal`);
  }
});

test('the MCP pair carries three different facts at three sites', () => {
  const prod = fs.readFileSync(path.join(ROOT, 'tools', 'mcp-tool-gate.cjs'), 'utf8').split('\n');
  // Local, not exported, and used within the block it is declared in.
  assert.match(prod[183], /const RESOURCE = \['ListMcpResourcesTool', 'ReadMcpResourceTool'\]/,
    'the production declaration changed shape');
  assert.match(prod[184], /RESOURCE\.filter/, 'the constant is no longer used where it is declared');
  assert.ok(!/module\.exports\s*=\s*\{[^}]*RESOURCE/.test(prod.join('\n')),
    'RESOURCE is now exported, so a consumer could share it');

  const deferred = fs.readFileSync(path.join(ROOT, 'test', 'deferred-tools-r501.test.mjs'), 'utf8').split('\n');
  assert.match(deferred[77], /for \(const name of \['ListMcpResourcesTool', 'ReadMcpResourceTool'\]\)/,
    'the deferred-tools assertion changed shape');
  assert.match(deferred[78], /shouldDefer|deferred\.includes/, 'the deferred-tools claim is gone');

  const gate = fs.readFileSync(path.join(ROOT, 'test', 'mcp-tool-gate-r504.test.mjs'), 'utf8').split('\n');
  assert.match(gate[74], /assert\.deepEqual\(d\.gained\.sort\(\)/,
    'the gate assertion changed shape');
});

test('the two tests assert different properties, so one constant would be wrong', () => {
  const deferred = fs.readFileSync(path.join(ROOT, 'test', 'deferred-tools-r501.test.mjs'), 'utf8');
  const gate = fs.readFileSync(path.join(ROOT, 'test', 'mcp-tool-gate-r504.test.mjs'), 'utf8');
  assert.match(deferred, /shouldDefer/, 'the deferred claim is not about shouldDefer');
  // `shouldDefer` appears in the gate test's HEADER COMMENT, which explains what R501 proposed and what the data
  // refuted. A claim is an assertion, not prose — so the check has to look at lines that assert.
  const gateAssertions = gate.split('\n').filter((l) => /^\s*assert\./.test(l)).join('\n');
  assert.ok(!/shouldDefer/.test(gateAssertions),
    'the gate test now also ASSERTS shouldDefer: the two claims merged');
  assert.match(gateAssertions, /gained/, 'the gate claim is not about what a server added');
});

test('the ledger reports the fraction after two more reads', () => {
  const r = runLedger(['--json']);
  assert.equal(r.status, 0, 'the ledger failed');
  const d = JSON.parse(r.stdout);
  assert.ok(d.read >= 17, `the ledger reports ${d.read} read, fewer than the 17 recorded here`);
  assert.equal(d.read + d.unread, d.liveGroups, 'the split does not sum');
});
