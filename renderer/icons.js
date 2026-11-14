// Icon set.
//
// Replaces the text glyphs (☰, ▥, ✳, ⌕ …) the reconstruction shipped in earlier
// rounds. Glyphs render differently per platform and font, which is why the
// original ships SVG paths instead.
//
// Two things here are observed from the bundle:
//
//   1. The mark. quick-window.html inlines it with the note "Inlined Claude
//      starburst logo. This is the same path used by the React AppLogo in
//      src/renderer/components/Icons.tsx — keep them in sync." The full 2423-byte
//      `d` is therefore RECOVERED, not reconstructed, and lives in mark-path.js.
//      The identical string also appears in index.chunk-lzaSYO3Q.js, so two
//      shipped locations agree. The view box (248x248) and the fill (#D97757)
//      come from that inline SVG and from MARK in index.chunk-BN7PaJ_P.js.
//
//   2. The icon component shape. MainWindowPage-BM1J3SeB.js defines icons as
//        {name, master16:[…], master20:[…]}
//      drawn with
//        fill:none; stroke:currentColor; stroke-width: 1 (16px) / 1.2 (20px);
//        stroke-linecap:round; stroke-linejoin:round; vector-effect:non-scaling-stroke
//      and a 32px size that uses the 20px master at stroke-width 1.8.
//
// The 25 named icons below are reconstruction: their geometry is drawn to match
// the measured UI. Only the mark's path is verbatim from the artifact.
'use strict';

import { MARK_PATH_D } from './mark-path.js';

const MARK_VIEWBOX = 248;
const MARK_COLOR = '#D97757';
const MARK_PATHS = MARK_PATH_D;

/** The Claude mark as an inline SVG string. */
function markSvg(size = 20, { color = MARK_COLOR, className = '' } = {}) {
  const cls = className ? ` class="${className}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg"${cls} viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
    + `<path d="${MARK_PATHS}" fill="${color}"/></svg>`;
}

// 16-unit master geometry. Each entry is a list of drawing primitives.
const ICONS = {
  menu: {
    16: [{ d: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11' }],
    20: [{ d: 'M3 5.5h14M3 10h14M3 14.5h14' }],
  },
  sidebar: {
    16: [{ d: 'M2.5 3.5h11v9h-11z' }, { d: 'M6.5 3.5v9' }],
    20: [{ d: 'M3 4.5h14v11H3z' }, { d: 'M8 4.5v11' }],
  },
  back: {
    16: [{ d: 'M9.5 4L5.5 8l4 4' }],
    20: [{ d: 'M11.5 5l-5 5 5 5' }],
  },
  forward: {
    16: [{ d: 'M6.5 4l4 4-4 4' }],
    20: [{ d: 'M8.5 5l5 5-5 5' }],
  },
  search: {
    16: [{ cx: 7, cy: 7, r: 3.6 }, { d: 'M9.7 9.7L13 13' }],
    20: [{ cx: 8.7, cy: 8.7, r: 4.6 }, { d: 'M12.1 12.1L16 16' }],
  },
  sort: {
    16: [{ d: 'M4.5 6.5h7M4.5 9.5h4.5' }],
    20: [{ d: 'M5 8h10M5 12h6' }],
  },
  theme: {
    16: [{ d: 'M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 010-11z' }, { d: 'M8 2.5v11' }],
    20: [{ d: 'M10 3a7 7 0 100 14 7 7 0 010-14z' }, { d: 'M10 3v14' }],
  },
  plus: {
    16: [{ d: 'M8 3.5v9M3.5 8h9' }],
    20: [{ d: 'M10 4v12M4 10h12' }],
  },
  folder: {
    16: [{ d: 'M2.5 5.5h4l1.2 1.5h5.8v6h-11z' }],
    20: [{ d: 'M3 6.5h5l1.5 2h7.5v7H3z' }],
  },
  artifacts: {
    16: [{ d: 'M8 2.5l4.5 2.6v5.8L8 13.5l-4.5-2.6V5.1z' }],
    20: [{ d: 'M10 3l5.5 3.2v7.6L10 17l-5.5-3.2V6.2z' }],
  },
  clock: {
    16: [{ cx: 8, cy: 8, r: 5.2 }, { d: 'M8 5.2V8l2 1.4' }],
    20: [{ cx: 10, cy: 10, r: 6.5 }, { d: 'M10 6.5V10l2.5 1.7' }],
  },
  more: {
    16: [{ cx: 3.5, cy: 8, r: 0.9, filled: true }, { cx: 8, cy: 8, r: 0.9, filled: true }, { cx: 12.5, cy: 8, r: 0.9, filled: true }],
    20: [{ cx: 4.5, cy: 10, r: 1.1, filled: true }, { cx: 10, cy: 10, r: 1.1, filled: true }, { cx: 15.5, cy: 10, r: 1.1, filled: true }],
  },
  terminal: {
    16: [{ d: 'M2.5 4.5h11v7h-11z' }, { d: 'M4.5 7l1.8 1.5-1.8 1.5' }, { d: 'M8.5 10h3' }],
    20: [{ d: 'M3 5.5h14v9H3z' }, { d: 'M5.5 8.5l2.2 1.8-2.2 1.8' }, { d: 'M10.5 12.2h3.5' }],
  },
  window: {
    16: [{ d: 'M2.5 4.5h11v7h-11z' }, { d: 'M8 4.5v7' }],
    20: [{ d: 'M3 5.5h14v9H3z' }, { d: 'M10 5.5v9' }],
  },
  run: {
    16: [{ d: 'M6 4l5 4-5 4z' }],
    20: [{ d: 'M7.5 5l6 5-6 5z' }],
  },
  file: {
    16: [{ d: 'M4 2.5h5l3 3v8H4z' }, { d: 'M9 2.5v3h3' }],
    20: [{ d: 'M5 3h6l4 4v10H5z' }, { d: 'M11 3v4h4' }],
  },
  archive: {
    16: [{ d: 'M2.5 4.5h11v2h-11z' }, { d: 'M3.5 6.5h9v6h-9z' }, { d: 'M7 8.5h2' }],
    20: [{ d: 'M3 5.5h14v2.5H3z' }, { d: 'M4.5 8h11v7.5h-11z' }, { d: 'M9 10.5h2' }],
  },
  close: {
    16: [{ d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }],
    20: [{ d: 'M5.5 5.5l9 9M14.5 5.5l-9 9' }],
  },
  chevronDown: {
    16: [{ d: 'M5 6.5L8 9.5l3-3' }],
    20: [{ d: 'M6.5 8L10 11.5 13.5 8' }],
  },
  stop: {
    16: [{ d: 'M5 5h6v6H5z', filled: true }],
    20: [{ d: 'M6.5 6.5h7v7h-7z', filled: true }],
  },
  minimize: {
    16: [{ d: 'M4 8h8' }],
    20: [{ d: 'M5 10h10' }],
  },
  maximize: {
    16: [{ d: 'M4.5 4.5h7v7h-7z' }],
    20: [{ d: 'M5.5 5.5h9v9h-9z' }],
  },
  send: {
    16: [{ d: 'M8 12.5v-9M4.5 7L8 3.5 11.5 7' }],
    20: [{ d: 'M10 15.5v-11M5.5 8.5L10 4l4.5 4.5' }],
  },
  refresh: {
    16: [{ d: 'M12.2 6.2A5 5 0 105.6 12' }, { d: 'M12.5 2.8v3.6H9' }],
    20: [{ d: 'M15.4 7.6A6.2 6.2 0 106.8 14.8' }, { d: 'M15.8 3.4v4.4h-4.4' }],
  },
  attach: {
    16: [{ d: 'M8 3.5v9M3.5 8h9' }],
    20: [{ d: 'M10 4v12M4 10h12' }],
  },
  // Idle-screen affordances.
  info: {
    16: [{ cx: 8, cy: 8, r: 5.6 }, { d: 'M8 7.2v4' }, { cx: 8, cy: 5.2, r: 0.55, filled: true }],
    20: [{ cx: 10, cy: 10, r: 7 }, { d: 'M10 9v5' }, { cx: 10, cy: 6.4, r: 0.7, filled: true }],
  },
  briefing: {
    16: [{ d: 'M2.5 4.5h11v9h-11z' }, { d: 'M4.8 7h6.4M4.8 9.4h6.4M4.8 11.8h3.6' }],
    20: [{ d: 'M3 5.5h14v11H3z' }, { d: 'M5.8 8.6h8.4M5.8 11.6h8.4M5.8 14.6h4.6' }],
  },
  inbox: {
    16: [{ d: 'M2.5 9.5h3l1 2h3l1-2h3' }, { d: 'M2.5 9.5l2-5h7l2 5v4h-11z' }],
    20: [{ d: 'M3 12h3.5l1.2 2.5h4.6L14 12h3' }, { d: 'M3 12l2.5-6h9L17 12v5H3z' }],
  },
  customize: {
    16: [{ d: 'M3 8h3M9 8h4' }, { cx: 8, cy: 8, r: 1.6 }, { d: 'M3 4.5h10M3 11.5h10' }],
    20: [{ d: 'M4 10h4M12 10h4' }, { cx: 10, cy: 10, r: 2 }, { d: 'M4 5.5h12M4 14.5h12' }],
  },
  // Account menu rows.
  gear: {
    16: [{ cx: 8, cy: 8, r: 2.2 }, { d: 'M8 2.4v1.6M8 12v1.6M2.4 8h1.6M12 8h1.6M4.05 4.05l1.13 1.13M10.82 10.82l1.13 1.13M11.95 4.05l-1.13 1.13M5.18 10.82l-1.13 1.13' }],
    20: [{ cx: 10, cy: 10, r: 2.8 }, { d: 'M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.41 1.41M13.69 13.69l1.41 1.41M15.1 4.9l-1.41 1.41M6.31 13.69L4.9 15.1' }],
  },
  globe: {
    16: [{ cx: 8, cy: 8, r: 5.6 }, { d: 'M2.4 8h11.2' }, { d: 'M8 2.4a9 9 0 010 11.2a9 9 0 010-11.2' }],
    20: [{ cx: 10, cy: 10, r: 7 }, { d: 'M3 10h14' }, { d: 'M10 3a11 11 0 010 14a11 11 0 010-14' }],
  },
  signout: {
    16: [{ d: 'M9.5 3.5h-5v9h5' }, { d: 'M7 8h6.5' }, { d: 'M11 5.5L13.5 8 11 10.5' }],
    20: [{ d: 'M12 4.5H6v11h6' }, { d: 'M9 10h8' }, { d: 'M14 7l3 3-3 3' }],
  },
  // Settings rail.
  shield: {
    16: [{ d: 'M8 2.5l5 1.8v4c0 2.6-2 4.6-5 5.2-3-.6-5-2.6-5-5.2v-4z' }],
    20: [{ d: 'M10 3l6.2 2.2v5c0 3.2-2.5 5.7-6.2 6.5-3.7-.8-6.2-3.3-6.2-6.5v-5z' }],
  },
  chart: {
    16: [{ d: 'M3 13h10' }, { d: 'M5 13V8M8 13V4.5M11 13V9.5' }],
    20: [{ d: 'M4 16h12' }, { d: 'M6.5 16v-6M10 16V6M13.5 16v-4' }],
  },
  code: {
    16: [{ d: 'M6 5.5L3 8l3 2.5' }, { d: 'M10 5.5L13 8l-3 2.5' }],
    20: [{ d: 'M7.5 6.5L4 10l3.5 3.5' }, { d: 'M12.5 6.5L16 10l-3.5 3.5' }],
  },
};

// Stroke widths from the bundle: 16px master → 1, 20px master → 1.2, and the
// 32px size reuses the 20px master at 1.8.
const STROKE = { 16: 1, 20: 1.2, 32: 1.8 };

function primitiveSvg(primitive, { stroke }) {
  // A filled primitive (dot, square) paints with currentColor and draws no
  // stroke; everything else is stroked with no fill. The two are exclusive, and
  // emitting both attributes was the source of a malformed `fill="currentColor"none`.
  const fill = primitive.filled ? 'currentColor' : 'none';
  const strokeAttrs = primitive.filled ? ' stroke="none"' : ` stroke="currentColor" stroke-width="${stroke}"`;
  const attrs = `fill="${fill}"${strokeAttrs}`;
  if ('d' in primitive) return `<path d="${primitive.d}" ${attrs}/>`;
  if ('cx' in primitive) {
    return `<circle cx="${primitive.cx}" cy="${primitive.cy}" r="${primitive.r}" ${attrs}/>`;
  }
  return '';
}

/**
 * Renders one icon.
 * @param {string} name key of ICONS
 * @param {object} options { size: 16|20|32, className }
 */
function iconSvg(name, { size = 16, className = '' } = {}) {
  const entry = ICONS[name];
  if (!entry) return '';
  const viewBox = size === 32 ? 20 : size;
  const master = viewBox === 16 ? entry[16] : entry[20];
  const stroke = STROKE[size] ?? STROKE[16];
  const cls = className ? ` class="${className}"` : '';
  const body = master.map(primitive => primitiveSvg(primitive, { stroke })).join('');
  // No inline style: the served CSP is `style-src 'self'`, so flex-shrink is set
  // from the stylesheet instead (see `.icon > svg`). The xmlns is required for
  // the string to parse as standalone SVG.
  return `<svg xmlns="http://www.w3.org/2000/svg"${cls} viewBox="0 0 ${viewBox} ${viewBox}" width="${size}" height="${size}" `
    + `fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" `
    + `aria-hidden="true" focusable="false">${body}</svg>`;
}

export { ICONS, MARK_VIEWBOX, MARK_COLOR, MARK_PATHS, markSvg, iconSvg, STROKE };


