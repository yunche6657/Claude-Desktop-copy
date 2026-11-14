// R617: the intersection came back empty — and not because the references are clean. 250 of 267 evidence files write no
// `file:line` at all, so there was almost nothing to intersect.
//
// THE QUESTION
//   R616 established six ambiguous positions: several tools point at one `file:line` while naming different subjects. The next
//   step was to check whether any EVIDENCE cites one of them, since a citation that looks precise would silently merge two subjects.
//
// THE MEASUREMENT
//       distinct file:line references across evidence/     22         occurrences 38
//       landing on an ambiguous position                    0
//       evidence files with at least one reference         17  of 267
//       HANDOFF files with at least one reference          12  of 253
//
//   The answer is zero, and the reason is not precision: 94% of the evidence never names a coordinate. The documents describe a
//   mechanism, quote source inline, or name a function — they do not write `desktop/foo.cjs:123`.
//
// WHY THAT MATTERS MORE THAN THE ZERO
//   This line of work has spent dozens of rounds computing exact positions and using them INSIDE tools. But the evidence for those
//   rounds is prose: falsifiable by reading the named function, and not addressable. A reader checking round 500's claim cannot jump
//   to it; they must find the function by name.
//
//   That is not a defect in a document. It is a property of the whole record, invisible until something tried to intersect on
//   position and found nothing to intersect with.
//
// WHAT WAS NOT DONE
//   No references were added to historical documents. The three that do carry them — STATUS.md (13), proof-list-order-r559 (3),
//   pure-key-r598 (2) — are not more correct than the rest. The measurement is the contribution.
//
// WHAT IS NOT CLAIMED
//   Not that prose evidence is weaker: naming a function and quoting its body is checkable by any reader, while a line number is
//   checkable only until the file moves — R574 lost a round to a recorded coordinate off by 19 lines.
//   Not that the 22 references are correct: this round compared them against six ambiguous positions, not against the files they name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE, TOP, IMPLICATION } from '../desktop/evidence-coverage.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EV = path.join(ROOT, 'evidence');
const REF = /(?:desktop|tools|test)\/[\w.-]+\.(?:cjs|mjs|js|json|md):\d+/g;

test('the reference coverage is still small and the counts match', () => {
  const files = fs.readdirSync(EV).filter((f) => f.endsWith('.md'));
  // The population grows every round; what must hold is that the record was measured against the CURRENT tree.
  assert.ok(files.length >= COVERAGE.evidenceFiles, `evidence/ shrank from ${COVERAGE.evidenceFiles} to ${files.length}`);

  let withRef = 0;
  const distinct = new Set();
  let occurrences = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(EV, f), 'utf8');
    const hits = [...text.matchAll(REF)];
    if (hits.length) withRef += 1;
    for (const h of hits) { distinct.add(h[0]); occurrences += 1; }
  }
  assert.ok(withRef >= COVERAGE.withReference, `${COVERAGE.withReference} -> ${withRef}: references vanished`);
  assert.ok(files.length - withRef >= 0, 'the buckets no longer partition');
  assert.ok(distinct.size >= COVERAGE.distinctReferences, `${COVERAGE.distinctReferences} -> ${distinct.size}`);
  assert.ok(occurrences >= COVERAGE.occurrences, `${COVERAGE.occurrences} -> ${occurrences}`);
});

test('no evidence reference lands on an ambiguous position', () => {
  const AMBIGUOUS = new Set([
    'desktop/growthbook-provider.cjs:45',
    'desktop/mcp-relay-host.cjs:10',
    'desktop/hybrid-oidc-login.cjs:7',
    'desktop/session-media-protocol.cjs:26',
    'desktop/session-video-protocol.cjs:25',
    'desktop/main.cjs:376',
  ]);
  let hits = 0;
  for (const f of fs.readdirSync(EV).filter((x) => x.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(EV, f), 'utf8');
    for (const m of text.matchAll(REF)) if (AMBIGUOUS.has(m[0])) hits += 1;
  }
  assert.equal(hits, COVERAGE.ambiguousHits, `${hits} references now land on an ambiguous position`);
});

test('the top-referencing file is still STATUS.md, with the recorded count', () => {
  const counts = TOP.map((t) => {
    const p = path.join(EV, t.file);
    if (!fs.existsSync(p)) return { ...t, actual: null };
    const text = fs.readFileSync(p, 'utf8');
    return { ...t, actual: new Set([...text.matchAll(REF)].map((m) => m[0])).size };
  });
  const first = counts[0];
  assert.equal(first.file, 'STATUS.md');
  assert.ok(first.actual >= first.refs, `STATUS.md went from ${first.refs} to ${first.actual}`);
});

test('the zero is explained as absence, not precision', () => {
  assert.match(COVERAGE.whyZero, /by absence rather than by precision/, 'the reason is not stated');
  assert.ok(COVERAGE.withoutReference > COVERAGE.withReference * 5, 'the majority is no longer overwhelming');
});

test('the record states what the prose shape implies for a reader', () => {
  assert.match(IMPLICATION.consequence, /at most 18 documents/, 'the reach of a position-based check is not stated');
  assert.match(IMPLICATION.notADefect, /checkable only until the file moves/, 'the trade-off is not stated');
  assert.match(IMPLICATION.precedent, /R574/, 'the precedent is not cited');
});

test('the record does not propose adding references retroactively', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'evidence-coverage.cjs'), 'utf8');
  assert.match(src, /No references were added to historical documents/, 'the no-backfill decision is not stated');
  assert.match(src, /not more correct than the rest/, 'the counter-claim is not stated');
});
