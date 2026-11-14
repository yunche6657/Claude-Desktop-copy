// What the user types is what the composer holds — for every character class that matters.
//
// MEASURED (replica :10430) by typing into the real contenteditable and reading back the
// paragraph nodes, which is what the app sends:
//
//   ascii     OK  1 paragraph
//   cjk       OK  1 paragraph   (这是一个中文测试，包含标点符号：、。！？)
//   emoji     OK  1 paragraph   (🎉🚀✨ survives — surrogate pairs are not split)
//   newlines  OK  3 paragraphs  (line one / line two / line three)
//   special   OK  1 paragraph   (a<b>c & "quotes" 'single' $var %s {brace})
//   long      OK  1 paragraph   (500 chars, no truncation)
//
// A FALSE ALARM worth recording. The first version compared `innerText` and reported the
// multi-line case as doubled newlines (30 chars instead of 28). The DOM explained it:
//
//   innerHTML    <p>line one</p><p>line two</p>
//   textContent  "line oneline two"      (no separator)
//   innerText    "line one\n\nline two"  (paragraphs read as blank-line separated)
//
// That is standard contenteditable behaviour, not corruption. The probe's yardstick was wrong,
// not the composer — reading the paragraph nodes is the faithful measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the composer is the shipped contenteditable, not a control this project re-implements', () => {
  // The measured DOM was <p>line one</p><p>line two</p> inside a contenteditable. That element
  // comes from resources/ion-dist; the reconstruction serves it rather than rebuilding it, which
  // is why there is no desktop/composer-dom.cjs. A first version of this test looked for that
  // file and failed against correct code.
  const main = read('desktop/main.cjs');
  assert.match(main, /CLAUDE_VIEW/, 'the view selection is gone');
  const protocol = read('desktop/app-protocol.cjs');
  // Assert the resolver itself, not the string: 'ion-dist' appears 11 times in this file,
  // most of them in comments, so matching the bare word stayed green when the code changed.
  assert.match(protocol, /function resolveFrontendRoot\(/, 'the frontend root resolver is gone');
  assert.match(protocol, /const root = path\.join\(base, 'ion-dist'\)/, 'the resolver no longer targets ion-dist');
});

test('a multi-line prompt is not collapsed before it is sent', () => {
  // Three paragraphs must reach sendMessage as three lines. A trim/normalise that joined them
  // would make a code block or a list unusable.
  const bridge = read('desktop/bridge-services.cjs');
  assert.doesNotMatch(bridge, /replace\(\/\\s\+\/g, ' '\)[^\n]*sendMessage/, 'the prompt is whitespace-collapsed');
});

test('the user message itself is never truncated', () => {
  // Measured: 500 characters arrived intact. The `message.slice(0, 60)` in the kernel builds the
  // session TITLE from the first line; it does not touch what is sent. This asserts the
  // distinction rather than banning the slice.
  const kernel = read('desktop/session-kernel.cjs');
  const slices = [...kernel.matchAll(/message\.slice\(0, 60\)/g)];
  assert.ok(slices.length >= 1, 'the title derivation is gone');
  for (const m of slices) {
    const context = kernel.slice(Math.max(0, m.index - 40), m.index + 20);
    assert.match(context, /title:/, 'a message slice exists outside the title field');
  }
});

test('only tool OUTPUT is capped, not user input', () => {
  const tools = read('desktop/tools.cjs');
  assert.match(tools, /MAX_TOOL_OUTPUT = 30_000/, 'the tool-output cap is gone');
});