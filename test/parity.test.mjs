// Geometry parity against measurements sampled from a real Claude 2.42304
// desktop window in the Code view (1936x1048 at 96 DPI). The numbers live in
// evidence/measurements.json; this test fails when the CSS drifts from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const m = JSON.parse(readFileSync(path.join(here, '../evidence/measurements.json'), 'utf8'));
const css = readFileSync(path.join(here, '../renderer/styles.css'), 'utf8');
const html = readFileSync(path.join(here, '../renderer/index.html'), 'utf8');

test('measurements describe a coherent Code view layout', () => {
  assert.equal(m.source.window, '1936x1048');
  assert.equal(m.source.dpi, 96);
  assert.equal(m.view, 'code');

  // Frame is 8px on each side, so client content is 1920x1032.
  const [w, h] = m.source.window.split('x').map(Number);
  assert.equal(m.sidebar.width + m.main.width, w - 16);
  assert.equal(m.titlebar.height + m.body.height, h - 16);

  // The transcript column is narrower than the composer pill and centred in the
  // main column, which is what the original screenshot shows.
  assert.ok(m.textColumn.width < m.composer.width);
  assert.ok(m.composer.left > m.sidebar.width);
  assert.ok(m.composer.left + m.composer.width <= w - 16);
  assert.ok(Math.abs(m.composer.left - m.textColumn.left) < 40);
});

test('CSS carries the measured sidebar, title bar and composer geometry', () => {
  // Colours are no longer asserted as sampled hex: the palette now comes from the
  // shipped stylesheet as bare HSL components, which are authoritative where a
  // screenshot sample is not (the sampled accent #e8c0b2 resolves to #d97757).
  for (const token of ['--bg-100', '--bg-000', '--bg-300', '--brand-200', '--text-400', '--text-000']) {
    assert.match(css, new RegExp(`${token}:\\s*[\\d.]+ [\\d.]+% [\\d.]+%`), `token ${token} must keep its HSL components`);
  }
  // The measured geometry still has to be present. The layout is a grid now, so
  // the sidebar width and chrome height live in the grid template; the measured
  // values are unchanged, only the property carrying them.
  assert.match(css, new RegExp(`grid-template-columns: ${m.sidebar.width}px`), 'sidebar width');
  assert.match(css, new RegExp(`grid-template-rows: ${m.titlebar.height}px`), 'title bar height');
  assert.match(css, /grid-row: 1 \/ span 2/, 'the rail must span the chrome row so its hairline is unbroken');
  assert.match(css, new RegExp(`height: ${m.composer.height}px`), 'composer pill height');
  assert.match(css, new RegExp(`max-width: ${m.composer.width + 48}px`), 'composer wrapper yields the measured pill width after padding');
  assert.match(css, new RegExp(`max-width: ${m.textColumn.width}px`), 'transcript column width');
  assert.match(css, new RegExp(`--radius: ${m.composer.radius}px`), 'pill radius');
});

test('the document exposes the measured structural landmarks', () => {
  // Measured structure: the rail spans the chrome row and the content row, so the
  // x=295 hairline is continuous through the title bar. The title bar sits over
  // the main column only.
  assert.match(html, /<header class="titlebar">/);
  assert.match(html, /<div class="rail-top">/);
  assert.equal(/<div class="body">/.test(html), false, 'the old stacked body wrapper is gone');
  assert.match(html, /<aside class="sidebar">/);
  assert.match(html, /class="segmented"/);
  assert.match(html, /class="pill"/);
  assert.match(html, /class="composer-row"/);
  // No inline styles: the CSP served by server.mjs is `style-src 'self'`.
  assert.equal(/\sstyle="/.test(html), false, 'inline style attributes would violate the CSP');
  assert.equal(/<script>/.test(html), false, 'no inline scripts');
});

test('renderer code never injects markup from session content', () => {
  const js = readFileSync(path.join(here, '../renderer/app.js'), 'utf8');
  assert.equal(/innerHTML/.test(js), false, 'use textContent, not innerHTML');
  assert.equal(/insertAdjacentHTML/.test(js), false);
  assert.equal(/document\.write/.test(js), false);
  assert.match(js, /textContent/, 'content must be written through textContent');
});

test('the stylesheet palette matches the tokens extracted from the artifact', () => {
  // evidence/design-tokens.json is produced by build/extract-tokens.cjs straight
  // from the shipped CSS, so this catches a hand-edited colour drifting away from
  // the artifact without re-reading the 251KB source in every test run.
  const evidence = JSON.parse(readFileSync(path.join(here, '../evidence/design-tokens.json'), 'utf8'));
  assert.ok(evidence.light && evidence.dark, 'both palettes must be present');
  assert.ok(Object.keys(evidence.light).length > 40, 'the light token set should be substantial');
  assert.ok(Object.keys(evidence.dark).length > 25, 'the dark token set should be substantial');

  // The light block is `:root`, the dark block is `body.dark`. Split them so a
  // token defined only in one theme cannot satisfy the other's assertion.
  const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('body.dark'));
  const darkBlock = css.slice(css.indexOf('body.dark'), css.indexOf('* { box-sizing'));

  const inBlock = (block, name) => {
    const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
    return match ? match[1].trim() : null;
  };

  for (const name of ['--bg-000', '--bg-100', '--bg-200', '--bg-300', '--bg-400',
    '--text-000', '--text-200', '--text-400', '--border-100', '--brand-000', '--brand-200']) {
    assert.equal(inBlock(rootBlock, name), evidence.light[name],
      `light ${name} must equal the artifact value`);
    assert.equal(inBlock(darkBlock, name), evidence.dark[name],
      `dark ${name} must equal the artifact value`);
  }

  // Font weights and the serif voice come from the same sheet.
  const weightMatch = rootBlock.match(/--cds-font-weight-semibold:\s*([^;]+);/);
  assert.ok(weightMatch, 'semibold weight must be declared');
  assert.equal(weightMatch[1].trim(), evidence.light['--cds-font-weight-semibold']);
  assert.ok(css.includes('ui-serif'), 'the serif voice stack must be present');
});

test('aliases are declared on body, not on :root', () => {
  // `var()` resolves where a custom property is defined, not where it is used.
  // An alias on :root freezes the light values and ignores the dark overrides on
  // body.dark, which is exactly the bug that made the theme toggle do nothing.
  const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('body.dark'));
  assert.equal(/--page\s*:/.test(rootBlock), false,
    'aliases must not live on :root or the dark overrides are invisible to them');

  const bodyStart = css.indexOf('\nbody {');
  const bodyBlock = css.slice(bodyStart, css.indexOf('button, input, textarea', bodyStart));
  assert.match(bodyBlock, /--page:\s*hsl\(var\(--bg-100\)\)/);
  assert.match(bodyBlock, /--text:\s*hsl\(var\(--text-000\)\)/);
  assert.match(bodyBlock, /--accent:\s*hsl\(var\(--brand-200\)\)/);
  assert.match(bodyBlock, /--border:\s*hsl\(var\(--border-100\)/);
});

test('no surface colour is hardcoded outside the token declarations', () => {
  // A hardcoded light hex inside a rule stays bright in dark mode; this caught a
  // #e2e2e1 hairline that remained light against the dark sidebar.
  const body = css.slice(css.indexOf('* { box-sizing'));
  // The --diff-* declarations are the only project-authored surface colours; they
  // are asserted separately below.
  const allowedSurfaces = new Set(['#eef8ef', '#fdf0ef']);

  const offenders = [];
  // {3,8} so a 3-digit #fff cannot slip through: twelve literal #fff surfaces
  // were invisible to the earlier {6} pattern and stayed white in dark mode.
  for (const match of body.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const hex = '#' + match[1];
    if (allowedSurfaces.has(hex)) continue;
    // Non-surface uses are legitimate and are exempted by their own context:
    //   - white text on a dark button (`color: #fff`)
    //   - black stops inside a mask gradient (opacity, not paint)
    //   - translucent black for shadows and ::backdrop
    // Slice the declaration that contains this hex: from the nearest rule opener to
    // the next semicolon. Testing the whole rule body (not a bare line) is what
    // makes `color: #fff` detectable when it follows other declarations.
    const open = Math.max(body.lastIndexOf('{', match.index), body.lastIndexOf('}', match.index));
    const close = body.indexOf(';', match.index);
    const declaration = body
      .slice(open + 1, close < 0 ? match.index + 30 : close)
      .split(';')
      .filter(part => part.includes(hex))
      .join(';');
    const isForeground = /color:\s*#fff/.test(declaration);
    const isMask = /mask-image/.test(declaration) || /mask-image/i.test(body.slice(Math.max(0, match.index - 200), match.index));
    // A translucent black is a shadow or a backdrop scrim, never a surface fill:
    // an 8-digit hex whose alpha is below ff is inherently a translucent overlay.
    //
    // MEASURED BUG: this pattern used to be /^#000[0-9a-fA-F]{2}$/, which needs exactly
    // '#' + 5 characters — no CSS hex is that long, so the branch was dead code and a
    // translucent black that was NOT inside a shadow/backdrop would have been reported.
    // The two real forms are spelled out separately: an 8-digit #000000xx (2 alpha digits)
    // and a 4-digit #000x (1 alpha digit). An all-f alpha is opaque, not translucent.
    const isTranslucentBlack =
      (/^#000000[0-9a-fA-F]{2}$/.test(hex) && !/ff$/i.test(hex))
      || (/^#000[0-9a-fA-F]$/.test(hex) && !/f$/i.test(hex));
    const isShadow = isTranslucentBlack
      || /shadow|backdrop/i.test(body.slice(Math.max(0, open - 40), match.index));
    if (isForeground || isMask || isShadow) continue;
    offenders.push(hex);
  }
  assert.deepEqual([...new Set(offenders)], [],
    'surface colours must come from tokens so both themes resolve');
});

test('motion tokens come from the artifact and drive real press feedback', () => {
  // Durations, easings and the spring curve are the values the shipped sheet uses.
  for (const [name, value] of Object.entries({
    '--cds-dur-fast': '60ms',
    '--cds-dur-snap': '0.12s',
    '--cds-dur-base': '0.2s',
    '--cds-dur-sheet': '0.3s',
    '--cds-dur-slow': '0.45s',
  })) {
    assert.match(css, new RegExp(`${name}:\\s*${value.replace('.', '\\.')}`), `${name} must be ${value}`);
  }
  assert.match(css, /--cds-btn-spring:\s*linear\(/, 'the spring curve must be declared');
  assert.match(css, /--cds-btn-press-scale:\s*0\.975/, 'the press scale must match .cds-btn-squish');
  assert.match(css, /--cds-ease-snap:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\)/);

  // The rules must actually consume them, not merely declare them.
  assert.match(css, /button:not\(:disabled\):active\s*\{[^}]*transform:\s*scale\(var\(--cds-btn-press-scale\)\)/,
    'press feedback must apply the scale');
  assert.match(css, /transition:\s*transform var\(--cds-dur-slow\) var\(--cds-btn-spring\)/,
    'the release must use the spring curve');
  assert.match(css, /transition:\s*transform var\(--cds-dur-fast\) ease-out/,
    'the press itself must be fast');
});

test('window buttons opt out of press scaling', () => {
  // OS window chrome highlights on press but never scales.
  assert.match(css, /\.win-buttons button:not\(:disabled\),\s*\n?\.win-buttons button:not\(:disabled\):active\s*\{\s*transform:\s*none;/,
    'window buttons must not scale');
});

test('scroll fade rules and the fade-size token are present', () => {
  assert.match(css, /--cds-scroll-fade-size:\s*28px/, 'the fade distance must be the artifact value');
  for (const state of ['fade-top', 'fade-bottom']) {
    assert.match(css, new RegExp(`\\.transcript\\.${state}\\s*\\{[^}]*mask-image`),
      `${state} must apply a mask`);
  }
  assert.match(css, /\.transcript\.fade-top\.fade-bottom\s*\{[^}]*linear-gradient\(\s*\n?\s*to bottom/,
    'both edges together need a two-sided gradient');
});

test('the translucent-black exemption recognises the hex forms CSS actually uses', () => {
  // The exemption inside the surface-colour test is an inline expression, so the CSS corpus
  // cannot exercise it: no rule in the sheet currently needs it (measured — disabling the
  // branch left the whole file green). Testing the predicate directly is the only way to pin
  // it, and it is worth pinning because the previous version was dead code:
  //   /^#000[0-9a-fA-F]{2}$/  needs '#' + 5 characters, which no CSS hex is.
  const isTranslucentBlack = (hex) =>
    (/^#000000[0-9a-fA-F]{2}$/.test(hex) && !/ff$/i.test(hex))
    || (/^#000[0-9a-fA-F]$/.test(hex) && !/f$/i.test(hex));
  // Translucent: black with partial alpha, in both spellings.
  assert.equal(isTranslucentBlack('#00000080'), true, '8-digit 50% black was not recognised');
  assert.equal(isTranslucentBlack('#00000012'), true, '8-digit 7% black was not recognised');
  assert.equal(isTranslucentBlack('#0008'), true, '4-digit 53% black was not recognised');
  // Opaque or non-black: none of these is a translucent black.
  assert.equal(isTranslucentBlack('#000000'), false, 'opaque 6-digit black was treated as translucent');
  assert.equal(isTranslucentBlack('#000'), false, 'opaque 3-digit black was treated as translucent');
  assert.equal(isTranslucentBlack('#000000ff'), false, 'fully opaque 8-digit black was treated as translucent');
  assert.equal(isTranslucentBlack('#ffffff'), false, 'white was treated as translucent black');
  assert.equal(isTranslucentBlack('#0000007f'), true, 'the boundary alpha 0x7f was not recognised');
});
