// Icon set tests.
//
// The icons are generated strings, so these assert the properties that make them
// usable in the page: every icon renders at each supported size, none of the
// output is malformed, and nothing emits an inline style (the served CSP is
// `style-src 'self'`, so an inline style would be blocked at runtime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICONS, iconSvg, markSvg, MARK_VIEWBOX, MARK_COLOR, MARK_PATHS, STROKE }
  from '../renderer/icons.js';

const NAMES = Object.keys(ICONS);

test('every icon renders at 16, 20 and 32', () => {
  assert.ok(NAMES.length >= 20, `expected a full set, got ${NAMES.length}`);
  for (const name of NAMES) {
    for (const size of [16, 20, 32]) {
      const svg = iconSvg(name, { size });
      assert.ok(svg.startsWith('<svg'), `${name}@${size} must start with <svg`);
      assert.ok(svg.endsWith('</svg>'), `${name}@${size} must be closed`);
      assert.ok(svg.includes(`width="${size}"`), `${name}@${size} width`);
      assert.ok(svg.includes(`height="${size}"`), `${name}@${size} height`);
      assert.ok(svg.includes('viewBox="0 0 '), `${name}@${size} viewBox`);
      assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), `${name}@${size} needs xmlns`);
      assert.ok(!/undefined|NaN|\[object/.test(svg), `${name}@${size} must not leak values`);
    }
  }
});

test('no icon emits an inline style attribute', () => {
  // `style="flex-shrink:0"` was present in an earlier revision and was blocked
  // by the CSP at runtime; the stylesheet carries that rule now.
  for (const name of NAMES) {
    for (const size of [16, 20, 32]) {
      const svg = iconSvg(name, { size });
      assert.ok(!/\sstyle=/.test(svg), `${name}@${size} must not set a style attribute`);
    }
  }
  assert.ok(!/\sstyle=/.test(markSvg(20)), 'the mark must not set a style attribute');
});

test('stroke widths follow the observed table', () => {
  assert.equal(STROKE[16], 1);
  assert.equal(STROKE[20], 1.2);
  assert.equal(STROKE[32], 1.8);

  assert.ok(iconSvg('menu', { size: 16 }).includes('stroke-width="1"'));
  assert.ok(iconSvg('menu', { size: 20 }).includes('stroke-width="1.2"'));
  assert.ok(iconSvg('menu', { size: 32 }).includes('stroke-width="1.8"'));
  // The 32px size reuses the 20px master geometry.
  assert.equal(
    iconSvg('menu', { size: 32 }).match(/d="[^"]+"/)[0],
    iconSvg('menu', { size: 20 }).match(/d="[^"]+"/)[0],
  );
});

test('filled primitives carry fill and no stroke', () => {
  const more = iconSvg('more', { size: 16 });
  // The dot icon is three circles, each filled and unstroked.
  assert.equal((more.match(/<circle/g) || []).length, 3);
  assert.ok(!/fill="currentColor"none/.test(more), 'malformed fill attribute');
  for (const circle of more.match(/<circle[^>]*>/g)) {
    assert.ok(circle.includes('fill="currentColor"'), 'a dot must be filled');
    assert.ok(circle.includes('stroke="none"'), 'a dot must not be stroked');
  }

  const stop = iconSvg('stop', { size: 16 });
  assert.ok(stop.includes('fill="currentColor"'));
  assert.ok(stop.includes('stroke="none"'));
});

test('outlined primitives carry a stroke and no fill', () => {
  const menu = iconSvg('menu', { size: 16 });
  assert.ok(menu.includes('fill="none"'));
  assert.ok(menu.includes('stroke="currentColor"'));
  assert.ok(menu.includes('stroke-width="1"'));
});

test('an unknown icon renders nothing rather than throwing', () => {
  assert.equal(iconSvg('does-not-exist'), '');
});

test('the mark keeps its observed view box and brand fill', () => {
  assert.equal(MARK_VIEWBOX, 248);
  assert.equal(MARK_COLOR, '#D97757');

  const svg = markSvg(18);
  assert.ok(svg.includes('viewBox="0 0 248 248"'), 'the view box is observed from the bundle');
  assert.ok(svg.includes('fill="#D97757"'), 'the fill is observed from the bundle');
  assert.ok(svg.includes('width="18"') && svg.includes('height="18"'));
  assert.ok(!/undefined|NaN/.test(svg));
});

test('the mark path is the real extracted geometry', () => {
  // Recovered verbatim from quick-window.html (and confirmed identical in
  // index.chunk-lzaSYO3Q.js): 2423 characters forming one closed subpath that
  // traces all twelve arms, not twelve separate subpaths.
  assert.equal(MARK_PATHS.length, 2423, 'the path must be the shipped bytes, unmodified');
  assert.equal((MARK_PATHS.match(/M/g) || []).length, 1, 'one M: a single subpath');
  assert.equal((MARK_PATHS.match(/Z/g) || []).length, 1, 'one Z: the subpath closes');
  assert.ok(MARK_PATHS.startsWith('M52.4285 162.873'), 'must start at the shipped origin');
  assert.ok(MARK_PATHS.endsWith('Z'), 'must close');
  assert.ok(!/undefined|NaN/.test(MARK_PATHS));

  // Every coordinate stays inside the 248 view box.
  const numbers = MARK_PATHS.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.ok(numbers.length > 100, 'the path carries real geometry');
  for (const n of numbers) {
    assert.ok(n >= 0 && n <= MARK_VIEWBOX, `coordinate ${n} outside the view box`);
  }
});

test('the icon set covers every surface the UI references', () => {
  // A missing key renders an empty string, which silently leaves a blank slot.
  for (const name of [
    'menu', 'sidebar', 'back', 'forward', 'search', 'sort', 'theme', 'plus', 'folder',
    'artifacts', 'clock', 'more', 'terminal', 'window', 'run', 'file', 'archive',
    'close', 'chevronDown', 'stop', 'minimize', 'maximize', 'send', 'refresh', 'attach',
    'info', 'briefing', 'inbox', 'customize', 'gear', 'globe', 'signout',
    'shield', 'chart', 'code',
  ]) {
    assert.ok(ICONS[name], `icon "${name}" must exist`);
    assert.ok(iconSvg(name, { size: 16 }).includes('viewBox'), `icon "${name}" must render`);
  }
});
