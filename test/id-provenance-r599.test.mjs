// R599: `validId` guards the EXTERNAL id and not the internal one. One line explains why, and it is provenance.
//
// THE QUESTION R598 LEFT
//   `hostPending` is written with `key(id)` and read with `key(q.id)`, and `validId(q.id)` runs before the read. Is it run before
//   the WRITE? If not, a malformed id could be stored and never retrieved — a leak plus the "prompt reappears" shape R596 found.
//
// THE ANSWER: THERE IS NOTHING TO VALIDATE AT THE WRITE
//       function request(binding, method, params, {signal, timeoutMs}) { …
//         const id = `relay:${++seq}`;
//         … hostPending.set(key(id), entry)
//
//   The id is generated from an internal counter and cannot be malformed, so a check would be dead code. The external id
//   arrives later in `q.id` from the subprocess, and that is where `validId` is applied — twice.
//
//       if (Object.hasOwn(q,'id')) { if (!validId(q.id) || originals.has(key(q.id))) throw Error('invalid…') }
//       if (!validId(q.id)) throw Error('invalid response id');
//
//   The asymmetry is exactly right: validate what crosses a boundary, not what you built yourself.
//
// WHY THIS NEEDED CHECKING AT ALL
//   R596 found a map written with a wider key than it was read with. `hostPending` has the same VISUAL shape — two expressions
//   naming one id — and what distinguishes them is the PROVENANCE of each side, not the text. One is a counter; the other is
//   subprocess output.
//
//   That is the third time in this line that provenance decided the question rather than form: R563 separated a replica from a
//   reconstruction by whether it EXECUTES the official slice, and R596's `tabAdmissions` looked like a rename until both
//   expressions were expanded.
//
// WHAT IS NOT CLAIMED
//   Not that `relay:${++seq}` cannot collide: `seq` is per-relay-instance and `hostPending` is too, so two relays do not share a
//   counter — but the claim is only that no check is NEEDED, not that the id is globally unique.
//   Not that these two are the module's only boundary checks: `method`, `timeoutMs` and the pending limit are validated in the
//   same guard block, which is a separate question.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVENANCE } from '../desktop/id-provenance.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'desktop', 'mcp-stdio-relay.cjs');

test('the written id is generated internally from a counter', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(src.includes('const id=`relay:${++seq}`'), 'the id is no longer an internal counter value');
  // And the write uses that same variable, not a caller-supplied one.
  assert.match(src, /hostPending\.set\(key\(id\),entry\)/, 'the write no longer keys by the generated id');
  assert.equal(PROVENANCE.written.validated, false);
  assert.match(PROVENANCE.written.whyNoValidation, /dead code/, 'the reason no check is needed is not stated');
});

test('the read id is external and validated at two sites', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const validSites = [...src.matchAll(/validId\(q\.id\)/g)];
  assert.equal(validSites.length, 2, `expected two validId(q.id) sites, found ${validSites.length}`);
  assert.match(src, /hostPending\.get\(key\(q\.id\)\)/, 'the read no longer keys by the response id');
  assert.equal(PROVENANCE.read.validated, true);
  assert.equal(PROVENANCE.read.sites, 2);
});

test('the validation precedes the read that needs it', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const firstValid = src.indexOf('validId(q.id)');
  const read = src.indexOf('hostPending.get(key(q.id))');
  assert.ok(firstValid >= 0 && read >= 0);
  assert.ok(firstValid < read, 'the read now happens before any validation, so an unvalidated id reaches the map');
});

test('no validation is applied to the generated id, and none should be', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // A `validId(id)` on the internal id would contradict the record.
  assert.ok(!/validId\(id\)/.test(src), 'the internal id is now validated, so the provenance argument is stale');
});

test('the provenance distinction is recorded as the deciding fact', () => {
  assert.match(PROVENANCE.conclusion, /crosses the boundary/, 'the principle is not stated');
  assert.match(PROVENANCE.written.origin, /internal/, 'the internal origin is not recorded');
  assert.match(PROVENANCE.read.origin, /external/, 'the external origin is not recorded');
});

test('the record carries the two earlier provenance decisions', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'id-provenance.cjs'), 'utf8');
  assert.ok(/R563/.test(src), 'the replica-versus-reconstruction precedent is missing');
  assert.ok(/tabAdmissions/.test(src), 'the R596 precedent is missing');
  assert.ok(/third time/.test(src), 'the pattern is not named as recurring');
});

test('no claim of global uniqueness is made', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'id-provenance.cjs'), 'utf8');
  assert.ok(/globally unique/.test(src), 'the uniqueness limit is not stated');
  assert.ok(/per-relay-instance/.test(src), 'the scope of the counter is not stated');
});
