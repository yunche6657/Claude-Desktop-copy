// R554: the list appeared eight times in production code, in two different orders — and R553 had read only the tests.
//
// THE CORRECTION THIS ROUND OWES
//   R553 concluded from the top group of tools/duplicated-lists.cjs that `['LocalSessions','LocalAgentModeSessions']`
//   existed only in test files, that production registered each namespace as its own literal, and that unifying the
//   tests would invent an abstraction production did not have. That was wrong.
//
//   The detector had reported `fileCount: 15, sites: 24` with eight sites under `desktop/`. R553 read the first four
//   sites, saw `test/`, and stopped. The claim "production code has no such array" was written from a partial read of a
//   complete output — the same failure this session has documented repeatedly, applied to a tool's own result.
//
//   `desktop/bridge-services.cjs` contains the array eight times: twice in the event fan-out and six times in
//   `define(...)` registration blocks.
//
// TWO ORDERS, NOT ONE
//   L1196 and L1215 had `LocalAgentModeSessions` first; the six registration sites had `LocalSessions` first. The order
//   is observable — L1196 walks the list emitting one IPC event per service, and the `define` blocks walk it
//   registering handlers in sequence. So the eight copies were already two different lists, and nothing compared them.
//
//   All eight now read `LOCAL_SERVICES`, defined once with `LocalSessions` first. That choice matches the six sites that
//   already used it and the namespace the tests exercise first; the point is that a reader no longer has to notice
//   which order a given loop uses.
//
// WHAT IS NOT CLAIMED
//   Not that the two orders had DIFFERENT observable behaviour in practice: the fan-out emits both namespaces and the
//   renderer would have to prefer the first-arriving channel for it to matter, which was not traced into the renderer.
//   What is established is that the order was two-valued and unreviewed, and that is now one value in one place.
//   Not that the 12 test files were unified: they legitimately sample the pair, and each loops over it for its own
//   assertion. Touching them would be a change with no defect behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'desktop', 'bridge-services.cjs');
const read = () => fs.readFileSync(BRIDGE, 'utf8');

test('the service list is defined exactly once in production code', () => {
  const src = read();
  const decls = [...src.matchAll(/const LOCAL_SERVICES = \[/g)];
  assert.equal(decls.length, 1, `LOCAL_SERVICES is declared ${decls.length} times`);
  // No inline pair may survive: the literal array must appear only in its own declaration.
  const inline = [...src.matchAll(/\['Local(Sessions|AgentModeSessions)',\s*'Local(Sessions|AgentModeSessions)'\]/g)];
  assert.equal(inline.length, 1,
    `the inline pair survives at ${inline.length} place(s) besides the declaration`);
});

test('every consumer reads the constant', () => {
  const src = read();
  const loops = [...src.matchAll(/for \(const \w+ of LOCAL_SERVICES\)/g)];
  assert.equal(loops.length, 8, `expected 8 loops over LOCAL_SERVICES, found ${loops.length}`);
});

test('the two orders are gone, and the surviving order is stated', () => {
  const src = read();
  const decl = /const LOCAL_SERVICES = \[([^\]]*)\]/.exec(src);
  assert.ok(decl, 'the declaration is gone');
  assert.match(decl[1], /^'LocalSessions', 'LocalAgentModeSessions'$/,
    `the order is now ${decl[1]}, which is neither of the two previously used — re-measure before changing it`);
  // The comment wraps and names the namespaces inside markdown code spans, so match on the surrounding words rather
  // than on the bare name — a regex over prose has to describe the prose, not the identifier.
  assert.match(src, /Two of the eight had[\s\S]{0,40}LocalAgentModeSessions[\s\S]{0,20}first and six/i,
    'the fact that the copies disagreed is not recorded at the constant');
  assert.match(src, /The order is not cosmetic|the order is observable/,
    'the reason the order matters is not stated');
});

test('R553s error is recorded, not quietly fixed', () => {
  // The correction belongs in the record: the tool had the sites, the reader stopped early.
  const src = read();
  assert.match(src, /CORRECTS A WRONG CONCLUSION FROM R553/, 'the round whose conclusion this corrects is not named');
  const evidence = fs.readFileSync(path.join(ROOT, 'evidence', 'duplicated-lists-r553.md'), 'utf8');
  assert.match(evidence, /生产代码里没有这个数组/, 'the R553 evidence file no longer contains the claim that was wrong');
});

test('the bridge still parses', () => {
  // A syntax failure here would take down every session. `--check` parses without loading, and is run in a child so the
  // ESM test file does not need `require`.
  const r = spawnSync(process.execPath, ['--check', BRIDGE], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, 'bridge-services.cjs does not parse:\n' + (r.stderr || '').slice(0, 600));
});
