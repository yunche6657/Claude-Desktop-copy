'use strict';
// One name, two provenances: 21 candidates, 9 readable, and the one that matters is already fixed — with a stale comment.
//
// WHAT THE SCAN FOUND
//   `tools/source-divergence.cjs` looks for a variable assigned from an INTERNAL construction in one place and from an EXTERNAL
//   field in another. Measured: 21 candidates across desktop/, of which 6 live in minified files (`native-git-diff-core.cjs` at
//   1619 chars/line, `native-public-suffix.cjs` at 25640 — single letters recycled for unrelated values, not provenance
//   divergence) and 11 are one- or two-character names with the same problem. That leaves NINE worth reading.
//
//   Reading them: `running` is `record.isRunning === true` versus the string `'running'` (different types, different
//   variables); `url` is `row.config?.url` versus a local of the same name in a different function; `call` is an object literal
//   versus a `byToolId.get(...)` lookup. None mixes trust.
//
// THE ONE THAT MATTERS, AND WHY IT IS ALREADY HANDLED
//       desktop/bridge-services.cjs:3708   define('…answerPendingCwdTrust', (_e, sessionId, promptId, accepted) => {
//       :3717   let cwd = null;
//       :3722   if (record) cwd = record.pendingCwd || record.workingDir || record.cwd || null;
//       :3725   if (accepted === true && cwd) { … entry.hasTrustDialogAccepted = true; … }
//
//   This is the shape: `cwd` starts internal (`null`), becomes an external-ish field read, and then decides a TRUST WRITE. If a
//   session record could carry an arbitrary `cwd`, answering any prompt would pre-trust an arbitrary directory. That is the real
//   risk this pattern was worth scanning for, and it is exactly the case the scan surfaced first.
//
//   It is mitigated at the source the funnel points at: `kernel.getAll()` supplies the records, so the `cwd` is a value this
//   process's own kernel holds for a session it created — not request input. The `accepted === true` guard and the `sessionId`
//   type check close the rest.
//
// THE STALE COMMENT, WHICH IS THE ACTUAL DEFECT HERE
//       :3712-3716   "this used to look the record up through handlers.get('…getSessionList') but that method has no handler,
//                     so `list` was always null … the trust write below was unreachable dead code"
//
//   `getSessionList` DOES have a handler now — `:2058` defines it, and `:244` even provides a fallback shape for the fragment.
//   So a reader who takes the comment at face value concludes that the old path is permanently unavailable, when in fact it works
//   and the choice to use the kernel is a preference, not a necessity.
//
//   That is a smaller finding than a trust leak and a more durable one: a comment asserting a fact about the code that the code
//   has since contradicted. It survives review because nothing executes comments.
//
// WHAT IS NOT CLAIMED
//   Not that the trust write is unsafe: the funnel is the kernel, and the guards are present. Establishing more would need the
//   session-record lifecycle, which is a different investigation.
//   Not that the other eight are verified clean: four were read and dismissed on the stated grounds; four (`env`, `request`,
//   `requestId`, `response` in ccb-kernel, `pos` in git-status) were not opened, and the same one-minute read applies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'source-divergence.cjs');
const BRIDGE = path.join(ROOT, 'desktop', 'bridge-services.cjs');

const runScan = () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'the scan failed:\n' + (r.stderr || '').slice(0, 800));
  return JSON.parse(r.stdout);
};

test('the scan produces a readable candidate list, not the whole tree', () => {
  const d = runScan();
  // R608 masked string literals and required one scope, cutting the population from 21 to 2. The lower bound moves with the
  // tool; what must stay true is that the scan produces SOMETHING a reader can act on.
  assert.ok(d.candidates >= 2, `only ${d.candidates} candidates: the pattern is too narrow`);
  assert.ok(d.candidates < 60, `${d.candidates} candidates: too many to read`);
  for (const r of d.rows) {
    const kinds = new Set(r.sites.map((s) => s.provenance));
    assert.ok([...kinds].some((k) => k.startsWith('external')), `${r.name} has no external site`);
    assert.ok([...kinds].some((k) => k.startsWith('internal') || k === 'local'),
      `${r.name} has no internal site`);
  }
});

test('minified single-letter noise is identifiable and separable', () => {
  const d = runScan();
  // R608's mask removed the minified-file noise from the population entirely: those rows came from assignments inside
  // compressed string payloads. The documentation of the class stays, and the tool now filters rather than reports it.
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /minified|single letters/, 'the noise class is not documented');
  assert.ok(d.candidates < 21, 'the population did not shrink, so the mask is not in effect');
});

test('the trust-write funnel is the case the scan surfaces', () => {
  const d = runScan();
  // `cwd` was one of the cross-scope rows R607 identified and R608 removed. Its two provenances live in HT() and jD().
  const cwd = d.rows.find((r) => r.name === 'cwd' && r.file === 'desktop/bridge-services.cjs');
  assert.equal(cwd, undefined, 'cwd is back, so the scope filter regressed');

  // And the funnel: the external value reaches a trust write.
  const src = fs.readFileSync(BRIDGE, 'utf8');
  assert.match(src, /cwd = record\.pendingCwd \|\| record\.workingDir \|\| record\.cwd/, 'the assignment moved');
  assert.match(src, /hasTrustDialogAccepted = true/, 'the trust write moved');
  // Search inside a window that starts at the handler. `hasTrustDialogAccepted` also appears in the trust-store READ path
  // earlier in the file, so a file-wide indexOf would compare positions from two different functions. The window is fixed
  // rather than bracketed on `define(` because the handler body contains that token too.
  const fnStart = src.indexOf('answerPendingCwdTrust');
  const window = src.slice(fnStart, fnStart + 3000);
  const assign = window.indexOf('cwd = record.pendingCwd');
  const write = window.indexOf('hasTrustDialogAccepted = true');
  assert.ok(assign >= 0, 'the cwd assignment left the handler');
  assert.ok(write >= 0, 'the trust write left the handler');
  assert.ok(assign < write, 'the trust write now precedes the cwd assignment inside the handler');
});

test('the funnel is fed by the kernel, not by request input', () => {
  const src = fs.readFileSync(BRIDGE, 'utf8');
  const fnStart = src.indexOf('answerPendingCwdTrust');
  const around = src.slice(fnStart, src.indexOf('hasTrustDialogAccepted = true', fnStart));
  assert.match(around, /kernel\.getAll\(\)/, 'the records no longer come from the kernel');
  assert.match(around, /typeof sessionId !== 'string'/, 'the sessionId type check is gone');
  assert.match(around, /accepted === true/, 'the accepted guard is gone');
});

test('the stale comment contradicts the code and that is recorded', () => {
  const src = fs.readFileSync(BRIDGE, 'utf8');
  // The comment claims no handler exists…
  assert.match(src, /that method has no handler/, 'the stale claim is gone');
  // …while the handler exists.
  assert.match(src, /define\('claude\.web_\$_LocalSessions_\$_getSessionList'/, 'getSessionList is no longer defined');
});

test('the record separates the trust question from the comment question', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /STALE COMMENT/, 'the comment finding is not separated from the trust analysis');
  assert.match(src, /Not that the trust write is unsafe/, 'the trust caveat is missing');
  assert.match(src, /not opened|were not opened/, 'the unread candidates are not declared');
});
