// Session titles: two paths, and what each is allowed to produce.
//
// MEASURED (replica :10460).
//
// A session's title is set from its FIRST message and never revised:
//   prompt 1 'Explain how TCP handshakes work, briefly.'  -> that sentence
//   prompts 2-5 (four more, incl. CJK)                    -> title unchanged
//
// Truncation, measured directly:
//   200-char first message  ->  titleLen 60
//
// But the longest titles already in the store are 120 and 109 characters, which is longer than
// 60 — so `message.slice(0, 60)` is not the only source. Reading the code: start({ title })
// accepts a caller-supplied title verbatim (`typeof info.title === 'string' ? info.title`),
// and only the fallback slices. Two paths, both intentional.
//
// The shipped bundle was also searched for title generation (generateSessionTitle,
// summariz*Title, titleForSession) across all 6 asset bundles: ZERO hits. There is no
// model-written title upstream, so the slice is this reconstruction's own rule, not a
// divergence from a shipped summariser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('a caller-supplied title is used verbatim, not truncated', () => {
  // Measured: 120-char titles exist in the store, which is only possible through this path.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /title: typeof info\.title === 'string' \? info\.title : undefined/,
    'the caller-supplied title path is gone');
});

test('the fallback title is the first message, sliced to 60 characters', () => {
  // Measured: a 200-char first message produced titleLen 60.
  const kernel = read('desktop/session-kernel.cjs');
  const slices = [...kernel.matchAll(/title: session\.title \|\| message\.slice\(0, 60\)/g)];
  assert.ok(slices.length >= 1, 'the fallback title rule is gone');
});

test('a title already set is never overwritten by a later message', () => {
  // Measured: five prompts in one session, title stayed on the first. `session.title ||` is
  // what enforces that — a plain assignment would follow the latest message.
  const kernel = read('desktop/session-kernel.cjs');
  assert.match(kernel, /session\.title \|\| message\.slice/, 'the title is reassigned on every turn');
});

test('the reconstruction does not claim a model-written title', () => {
  // The shipped bundles contain no title-generation symbol; inventing one would be a
  // divergence presented as fidelity.
  const kernel = read('desktop/session-kernel.cjs');
  assert.doesNotMatch(kernel, /generateSessionTitle|summariz\w*[Tt]itle/, 'a summariser appeared without evidence');
});
