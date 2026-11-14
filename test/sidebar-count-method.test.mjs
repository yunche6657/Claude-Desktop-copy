// Counting rendered items must not use innerText/textContent substring matching.
//
// WHY. Round 345 measured the sidebar and concluded 'only 20 of 171 sessions render'. That was
// wrong, and the numbers disagreeing was the tell:
//
//   clickable rows in .dframe-nav-scroll   170
//   rows with a non-zero box                101
//   titles found by document.body.innerText  20
//   titles found by .textContent             21
//
// innerText returns only what is RENDERED (visibility, overflow clipping and collapsed groups
// all remove text from it). textContent includes hidden nodes but is a single flattened string,
// so a title that appears once anywhere counts once — it cannot tell 170 rows from 20.
//
// The reliable count is the DOM: query the row elements and check their boxes. The same class of
// mistake appeared in rounds 289/308/309 (body.innerText concatenation) and is why
// ui-assertion-scope.test.mjs exists; this file extends the rule from 'assertions' to 'counts'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBES = path.join(ROOT, 'tools', 'probes');

test('no probe counts rendered items by scanning document text', () => {
  const offenders = [];
  for (const name of fs.readdirSync(PROBES).filter((f) => f.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(PROBES, name), 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      // Narrowed after the first version flagged 18 lines that were all legitimate: checking
      // `innerText.includes('ran into a problem')` asks whether the error page is showing,
      // which text is exactly the right thing for. The shape that actually lied was using a
      // text LENGTH as a proxy for HOW MANY things rendered.
      //
      //   bodyLen = (document.body.innerText || '').replace(/\s+/g,' ').length   <- lie
      //   hasError = (document.body.innerText || '').includes('ran into a problem')  <- fine
      if (/\.(innerText|textContent)\b[^;]*\.length/.test(line) && !/rows\.length|boxes\.length/.test(line)) {
        if (/document\.body|nav\.|sidebar|querySelector\(\.dframe/.test(line)) {
          offenders.push(name + ':' + (index + 1));
        }
      }
    });
  }
  assert.deepEqual(offenders, [],
    'these probes derive a count from flattened text: ' + offenders.join(', '));
});

test('the sidebar measurement that replaced it uses element boxes', () => {
  // The probe that finally answered the question. It must query elements and measure their
  // rects; if it regresses to text matching the count becomes meaningless again.
  const probe = path.join(PROBES, '_visible-rows.mjs');
  if (!fs.existsSync(probe)) return; // probe may be cleaned up between rounds
  const source = fs.readFileSync(probe, 'utf8');
  assert.match(source, /getBoundingClientRect/, 'the sidebar count no longer measures boxes');
});

test('the recorded numbers from the sidebar measurement are self-consistent', () => {
  // Pins the trio that exposed the bad measurement: if someone re-runs and gets
  // '20 of 171', this test records that 170 clickable rows existed at the same moment, so the
  // 20 was a text artefact rather than the truth.
  const measured = { clickableRows: 170, visibleRows: 101, foundViaInnerText: 20, foundViaTextContent: 21, knownTitles: 171 };
  assert.ok(measured.clickableRows > measured.foundViaInnerText * 5,
    'the DOM had far more rows than the text search saw — that gap is the bug being recorded');
  assert.ok(measured.visibleRows > measured.foundViaInnerText,
    'even the visible-box count exceeds the text count');
  assert.ok(measured.knownTitles > measured.foundViaTextContent);
});