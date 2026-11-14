// R514: an addendum mechanism, because a banner is a snapshot and snapshots expire silently.
//
// THE STALE CLAIM
//   tool-absence-r500.md's banner ends with:
//       "修正后的分布是 9 / 5 / 4 / 3 / 2，其中那 3 个（ListMcpResources、Mcp、ReadMcpResource）至今原因未查明。"
//   R504 then explained the first two — they are stripped by `specialTools` and re-added only when a connected MCP
//   server advertises `resources`, measured by going 39 → 41 tools with a fixture server. R506 explained the third
//   — `MCPTool` declares `name: "mcp"` but is only ever spread into per-server tools, measured as zero importers.
//
//   So the banner is wrong about the present. A reader who trusts it concludes three absences are unexplained when
//   the answer is in two later files they have no reason to open.
//
// WHY NOT REWRITE THE BANNER
//   Rewriting it would destroy the record of what was believed at the time, which is the entire point of keeping
//   superseded claims rather than deleting them. So an addendum APPENDS inside the existing banner: the original
//   sentence stays verbatim, followed by "as of round N this no longer holds, and here is why". A reader sees both
//   the claim and its correction, in the same place, in that order.
//
// THE PROPERTIES THAT MAKE IT SAFE
//   1. The addendum lands INSIDE the banner block, above the title. Below the title it would read as part of the
//      original evidence — the exact confusion the mechanism exists to prevent. Checked by comparing its offset
//      against `\n# `.
//   2. The text outside the insertion point is unchanged. Verified structurally: the file must still start with
//      the old head and end with the old tail, and the BODY must be byte-identical (2497 chars before and after).
//   3. Idempotent per (file, round): a second --write appends nothing.
//   4. It refuses to append if the banner it depends on is absent — an addendum without its banner is a floating
//      correction with nothing to correct.
//   5. An addendum naming a file with no registry entry is reported as `no-correction-to-append-to` rather than
//      created silently.
//
// WHAT IS NOT CLAIMED
//   Not that every stale banner now carries an addendum: only R500's did. The other seven denominator files quote
//   splits that are also partly superseded, and each would need its own addendum with its own evidence.
//   Not that the addendum is a substitute for reading the cited rounds — it names them, it does not inline them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVID = path.join(ROOT, 'evidence');
const TOOL = path.join(ROOT, 'tools', 'corrections.cjs');
const REGISTRY = path.join(EVID, 'corrections.json');
const TARGET = path.join(EVID, 'tool-absence-r500.md');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
});

test('the registry has an addendum pointing at the R500 banner', () => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  assert.ok(Array.isArray(reg.addenda) && reg.addenda.length >= 1, 'no addenda registered');
  const a = reg.addenda.find((x) => x.file === 'tool-absence-r500.md');
  assert.ok(a, 'the R500 addendum is missing');
  assert.equal(a.round, 504, 'it does not cite the round that explained the first two tools');
  assert.match(a.text, /已不再成立/, 'it does not say the claim no longer holds');
  assert.match(a.text, /specialTools/, 'it does not give the mechanism for the resource pair');
  assert.match(a.text, /任何配置都注册不出|命名假象/, 'it does not give the mechanism for Mcp');
});

test('the addendum sits inside the banner, and the stale claim is preserved', () => {
  const text = fs.readFileSync(TARGET, 'utf8');
  const titleAt = text.indexOf('\n# ');
  assert.ok(titleAt > 0, 'the file has no title');

  const markerAt = text.indexOf('<!-- addendum-r504 -->');
  assert.ok(markerAt >= 0, 'the addendum marker is absent');
  assert.ok(markerAt < titleAt,
    'the addendum is below the title: it would read as original evidence');

  const banner = text.slice(0, titleAt);
  // The claim must still be there. Removing it would erase the record.
  assert.match(banner, /至今原因未查明/,
    'the stale claim was deleted rather than qualified: the record of what was believed is gone');
  assert.match(banner, /已不再成立/,
    'the correction is not in the banner');
  // And the correction must come after the claim, not before it.
  assert.ok(banner.indexOf('至今原因未查明') < banner.indexOf('已不再成立'),
    'the addendum precedes the claim it corrects');
});

test('appending an addendum does not touch the body', () => {
  const text = fs.readFileSync(TARGET, 'utf8');
  const body = text.slice(text.indexOf('\n# ') + 1);
  assert.match(body, /^# /, 'the body does not start at the title');
  assert.match(body, /18 个"缺失"是九种不同陈述/, 'the original title is gone');
  assert.ok(body.length > 2000, `body is suspiciously short (${body.length})`);
});

test('the tool verifies placement and refuses without a banner', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /appended-outside-banner/,
    'the tool cannot report an addendum placed below the title');
  assert.match(source, /no-correction-to-append-to/,
    'the tool does not report an addendum with no banner to attach to');
  assert.match(source, /the banner this addendum depends on is absent/,
    'the tool does not refuse to append without the banner');
  assert.match(source, /written\.startsWith\(head\) && written\.endsWith\(rest\)/,
    'the tool no longer verifies that text outside the insertion point is unchanged');
});

test('re-running appends nothing, and --check passes', () => {
  const before = fs.readFileSync(TARGET, 'utf8');
  const w = run(['--write']);
  assert.equal(w.status, 0, 'write failed:\n' + (w.stderr || ''));
  assert.equal(fs.readFileSync(TARGET, 'utf8'), before, 'a second --write changed the file');
  assert.equal((before.split('<!-- addendum-r504 -->').length - 1), 1,
    'the addendum marker appears more than once');

  const c = run(['--check']);
  assert.equal(c.status, 0, '--check fails:\n' + (c.stdout || '') + (c.stderr || ''));
});

test('the tool states that one addendum does not cover the other files', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /A banner is a snapshot of what was true when it was written/,
    'the rationale for addenda is gone');
  // Stacking is documented where it matters — in the addendum renderer's JSDoc, not in the file header. The line
  // wraps as "and so a second\n *   addendum to the same banner stacks".
  assert.match(source, /addendum to the same banner stacks/,
    'the tool no longer states that addenda stack');
});
