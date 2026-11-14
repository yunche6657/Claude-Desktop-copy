// Extract the design tokens from the shipped stylesheet.
//
// The artifact defines the palette twice: the light set on :root and the dark set
// on .darkTheme. Both are bare HSL components consumed through hsl(var(--x)), so
// they are preserved in that form rather than flattened to hex.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function blockVars(css, selectorPattern) {
  const re = new RegExp(selectorPattern + '\\s*\\{', 'g');
  const out = {};
  let m;
  while ((m = re.exec(css))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = css.slice(m.index + m[0].length, i);
    for (const v of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) {
      if (!(v[1] in out)) out[v[1]] = v[2].trim();
    }
  }
  return out;
}

const keep = key => /^--(bg|text-\d|border-\d|brand|oncolor|accent|cds-(radius|shadow|font|ring))/i.test(key);

function main() {
  const root = process.argv[2];
  if (!root) throw new Error('usage: extract-tokens.cjs <workspace-root>');
  const cssPath = path.join(root, 'ccd-ref', 'asar', '.vite', 'renderer',
    'main_window', 'assets', 'MainWindowPage-DTxMhyWF.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  const light = blockVars(css, ':root');
  // The dark palette lives on .darkTheme, not on a media query.
  const dark = blockVars(css, '\\.darkTheme');

  const pick = source => Object.fromEntries(Object.entries(source).filter(([k]) => keep(k)));

  const dest = path.join(root, 'claude-code-desktop', 'evidence', 'design-tokens.json');
  fs.writeFileSync(dest, JSON.stringify({
    source: '.vite/renderer/main_window/assets/MainWindowPage-DTxMhyWF.css',
    extractedAt: new Date().toISOString(),
    note: 'Values are bare HSL components, exactly as the artifact declares them.',
    light: pick(light),
    dark: pick(dark),
  }, null, 2));

  console.log('light tokens:', Object.keys(pick(light)).length);
  console.log('dark tokens :', Object.keys(pick(dark)).length);
  console.log('written     :', dest);
}

main();
