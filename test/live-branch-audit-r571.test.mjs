// R571: the generic question "is this branch live?" was attempted and withdrawn. Three cases were read instead.
//
// THE DETECTOR WAS WRONG THREE TIMES, ON THE SAME FILE
//   R570 said the expensive failure mode is a text assertion that keeps matching a DEAD branch. R571 tried to detect
//   liveness — "is the name a branch decides on produced elsewhere in the file?" — and:
//
//     1. excluded the branch's own line       `const denied = gate(row,false); if (denied) return denied;` — the producer
//                                             shares that line, so `denied` looked used nowhere. Also dropped
//                                             `agent.cjs:146`, the one line the round existed to check.
//     2. counted that line, required uses > 1  `denied` occurs three times on the one line and nowhere else → line count 1.
//     3. required `const/let/var NAME =`       `catch (error) { … if (error instanceof AgentError) … }` — `error` is bound
//                                             by the catch clause, so 356 of 3346 branches were flagged, including every
//                                             `err.code === 'EADDRINUSE'` guard.
//
//   Each fix narrowed the rule; the next shape defeated it. The fourth fix would be "also count catch params, function
//   params, destructuring, reduce callbacks" — a parser, not a rule. So it is withdrawn, and the count that remains is of
//   COMMENTS, not control flow: a branch whose own comment records an observation has a witness; one without does not.
//
// THE THREE READ BY HAND, ALL LIVE
//       bridge-services.cjs:233   /searchSessions$/ → []
//       bridge-services.cjs:242   /listCliSessions$/ → []
//           Both sit BEFORE line 243, `if (/Sessions$/i.test(frag) || …) return { sessions: [], … }`, which matches them
//           too. Remove or reorder either and the palette receives an object where it iterates — "l is not iterable" —
//           or passes it to `e.map(jo)` — "a.map is not a function". The comments record both, the second naming the
//           bundle that consumes it.
//
//       agent.cjs:146             if (error instanceof AgentError) throw error;
//           `messagesEndpoint(baseUrl)` is inside the same try, so a missing base URL threw 'invalid-base-url' and was
//           rewritten to 'network'. The comment records the observed value: {code:'network', message:'request failed: a
//           base URL is required'} — right sentence, wrong code.
//
//   THREE OUT OF THREE LIVE is the answer to R570's question for the cases R570 raised. The generic detector could not
//   have told you that, and three narrower versions of it actively lied.
//
// WHAT IS NOT CLAIMED
//   Not that the 121 witnessed branches are the live ones: a comment is not a proof, and a branch can be live without
//   anyone writing a note. The count is of documentation, deliberately.
//   Not that the remaining 3231 are unverified forever — most are ordinary guards no one needed to explain.
//   Not that three cases settle the 19: they are the three R570 read. The other 16 are still unread, and reading them is
//   the only way, per this round's result.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERIFIED_LIVE, SHARED_PROPERTY } from '../desktop/text-branch-witnesses.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'live-branch-audit.cjs');

const run = (args = []) => spawnSync(process.execPath, [TOOL, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });

test('the three hand-read branches are still exactly where the record says', () => {
  for (const v of VERIFIED_LIVE) {
    const lines = fs.readFileSync(path.join(ROOT, v.file), 'utf8').split('\n');
    assert.equal(lines[v.line - 1].trim(), v.branch,
      `${v.file}:${v.line} no longer holds the recorded branch`);
  }
  assert.equal(VERIFIED_LIVE.length, 3);
});

test('each recorded branch still carries the comment that proves it mattered', () => {
  for (const v of VERIFIED_LIVE) {
    const lines = fs.readFileSync(path.join(ROOT, v.file), 'utf8').split('\n');
    const above = lines.slice(Math.max(0, v.line - 9), v.line - 1).join('\n');
    assert.ok(/MEASURED|not iterable|not a function|TypeError/.test(above),
      `${v.file}:${v.line} lost the comment that witnesses it`);
  }
});

test('the order-pinning pair really is before the rule that would claim them', () => {
  // The claim in the record, verified against the file rather than trusted.
  const lines = fs.readFileSync(path.join(ROOT, 'desktop', 'bridge-services.cjs'), 'utf8').split('\n');
  const search = lines.findIndex((l) => l.includes('/searchSessions$/i.test(frag)'));
  const listCli = lines.findIndex((l) => l.includes('/listCliSessions$/i.test(frag)'));
  const generic = lines.findIndex((l) => /if \(\/Sessions\$\/i\.test\(frag\)/.test(l));
  assert.ok(search > 0 && listCli > 0 && generic > 0, 'one of the three branches is missing');
  assert.ok(search < generic, 'searchSessions is no longer before the generic Sessions rule');
  assert.ok(listCli < generic, 'listCliSessions is no longer before the generic Sessions rule');
});

test('the audit counts witnesses, not liveness', () => {
  const r = run(['--json']);
  assert.equal(r.status, 0, 'the audit failed:\n' + (r.stderr || '').slice(0, 800));
  const d = JSON.parse(r.stdout);
  assert.ok(d.branches > 3000, `only ${d.branches} branches found`);
  assert.ok(d.witnessed > 0, 'no witnessed branch at all');
  assert.ok(d.witnessed < d.branches, 'every branch is witnessed, which cannot be right');
  assert.equal(d.witnessed, d.rows.filter((x) => x.witness).length, 'the count does not match the rows');
  // And the two files from the record are in it.
  for (const v of VERIFIED_LIVE) {
    assert.ok(d.rows.some((x) => x.file === v.file && x.line === v.line && x.witness),
      `${v.file}:${v.line} is not reported as witnessed`);
  }
});

test('the tool says the liveness detector was withdrawn and why', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NOT a liveness detector/, 'the output claims more than it measures');
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /was wrong three times|wrong three times/, 'the three failures are not recorded');
  assert.match(src, /catch \(error\)/, 'the third failure — the catch binding — is not named');
});

test('the shared property is stated and is checkable', () => {
  assert.equal(SHARED_PROPERTY, 'each branch prevents a LATER branch from claiming the same input');
  // The two bridge-services branches and the agent branch all precede a later branch that would take the same input.
  const agent = fs.readFileSync(path.join(ROOT, 'desktop', 'agent.cjs'), 'utf8').split('\n');
  const branch = agent.findIndex((l) => l.includes('instanceof AgentError) throw error'));
  assert.ok(agent[branch + 1].includes("'network'"),
    'the AgentError passthrough is no longer followed by the generic network error it prevents');
});
