// R479: the shipped installer carries the banner-pointer patch.
//
// WHY THIS ROUND EXISTS
//   R478 fixed the dead send click by injecting a stylesheet, and verified it live against
//   release/win-unpacked. But the INSTALLER (release/*.exe, built in an earlier round) still contained
//   the pre-patch app.asar. A user installing from that file would get the broken build. That is a
//   delivery-level inconsistency, not a code one — exactly the class of gap R460 hit when
//   `--prepackaged` silently shipped an installer with no frontend at all.
//
// HOW IT WAS REBUILT
//   electron-builder rejects the spaced path ("注册号 逆向") for NSIS argument quoting, so the packaging
//   ran from C:\ccd-build-r460, which R460 already prepared as a no-spaces mirror. Two facts had to hold
//   before packaging:
//     - the mirror's resources/ion-dist is a real copy (4458 files / 181.7 MB), not a junction, so
//       electron-builder can read it
//     - the mirror's agent-core is a JUNCTION to the source, which is why `build/build.cjs --target asar`
//       refuses it ("agent-core payload is not a plain directory"). The asar was therefore built in the
//       source tree and copied in, rather than rebuilt in the mirror.
//
//   Packaging ran WITHOUT --prepackaged, deliberately: that flag skips the rebuild and ships whatever
//   win-unpacked already holds. R460 shipped a frontend-less installer that way.
//
// WHAT WAS CHECKED, AND ONE FALSE ALARM WORTH RECORDING
//   After packaging, win-unpacked/resources/agent-core showed 748 files against the source's 1483. That
//   looks like the R460 defect again. It is not: the source has exactly 735 `.map` files, and
//   `extraResources.filter: ["!**/*.map"]` removes them. 1483 - 735 = 748, and the packaged tree has
//   zero .map files and all 744 non-map dist files. The filter is working as designed — the count
//   difference is the filter, not a missing payload.
//
//   The installer's own payload was then extracted with 7za and its app.asar read directly: 187.59 MB,
//   containing desktop/frontend-layout-patches.cjs with the corrected `:where(...)` rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'release');
const INSTALLER = path.join(RELEASE, 'Code Desktop (Reconstruction)-0.1.0-x64.exe');
const UNPACKED_ASAR = path.join(RELEASE, 'win-unpacked', 'resources', 'app.asar');

const readAsarFile = (asarPath, entry) => {
  // Read the asar header directly rather than depending on the extractor's API surface.
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const header = Buffer.alloc(headerSize);
    fs.readSync(fd, header, 0, headerSize, 16);
    const parsed = JSON.parse(header.toString('utf8'));

    let node = parsed;
    for (const part of entry.split('/')) {
      node = node && node.files && node.files[part];
      if (!node) return null;
    }
    const base = 16 + headerSize;
    const data = Buffer.alloc(node.size);
    fs.readSync(fd, data, 0, node.size, base + Number(node.offset));
    return data.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
};

test('the installer exists at a plausible size', () => {
  assert.ok(fs.existsSync(INSTALLER), 'no installer in release/');
  const size = fs.statSync(INSTALLER).size;
  // The R460 regression was a 0.18 MB stub; a real payload is ~195 MB.
  assert.ok(size > 100 * 1024 * 1024,
    `installer is only ${(size / 1048576).toFixed(2)} MB — that is the empty-stub failure mode`);
});

test('win-unpacked app.asar carries the corrected banner patch', () => {
  assert.ok(fs.existsSync(UNPACKED_ASAR), 'win-unpacked/resources/app.asar is missing');
  const patch = readAsarFile(UNPACKED_ASAR, 'desktop/frontend-layout-patches.cjs');
  assert.ok(patch, 'frontend-layout-patches.cjs is absent from the packaged asar');

  assert.ok(patch.includes(':where('),
    'the packaged patch is the v1 blanket rule, which turned the send button transparent');
  assert.ok(patch.includes('code-prompt-send'),
    'the packaged patch does not name the send button');
  assert.ok(patch.includes('desktop-notification-permission-banner'),
    'the packaged patch does not target the banner');
});

test('main.cjs in the packaged asar wires the patch after load', () => {
  const main = readAsarFile(UNPACKED_ASAR, 'desktop/main.cjs');
  assert.ok(main, 'desktop/main.cjs is absent from the packaged asar');
  const loadIdx = main.indexOf('win.loadURL(useFrontend ? FRONTEND_URL : origin)');
  const patchIdx = main.indexOf('applyFrontendLayoutPatches');
  assert.ok(loadIdx > 0, 'the loadURL call is missing from the packaged main.cjs');
  assert.ok(patchIdx > 0, 'the packaged main.cjs never applies the layout patches');
  assert.ok(patchIdx > loadIdx, 'the patch runs before loadURL in the packaged build');
});

test('agent-core in the packaged tree has every non-map file', () => {
  const deployed = path.join(RELEASE, 'win-unpacked', 'resources', 'agent-core');
  if (!fs.existsSync(deployed)) {
    assert.fail('agent-core is absent from win-unpacked — this is the R460 defect');
  }

  const countFiles = (dir) => {
    let n = 0;
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else n += 1;
      }
    };
    walk(dir);
    return n;
  };
  const countMaps = (dir) => {
    let n = 0;
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.map')) n += 1;
      }
    };
    walk(dir);
    return n;
  };

  const source = path.join(ROOT, 'agent-core');
  const sourceMaps = countMaps(source);
  const sourceTotal = countFiles(source);
  const deployedMaps = countMaps(deployed);
  const deployedTotal = countFiles(deployed);

  // Two negation-only filters apply: ["!**/*.map", "!claude-code-src/**"]. Everything else must survive.
  const countShipped = (dir) => {
    let n = 0;
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (!entry.name.endsWith('.map') && !full.split(path.sep).includes('claude-code-src')) n += 1;
      }
    };
    walk(dir);
    return n;
  };
  const expectedShipped = countShipped(source);

  assert.equal(deployedMaps, 0, `the packaged agent-core still contains ${deployedMaps} .map files`);
  assert.equal(deployedTotal, expectedShipped,
    `packaged agent-core has ${deployedTotal} files, expected ${expectedShipped} `
    + `(source ${sourceTotal}, minus ${sourceMaps} maps and the claude-code-src tree, overlap counted once). `
    + 'A larger shortfall means the extraResources '
    + 'filter is dropping real payload, which is the R460 defect.');

  // And the two files the runtime cannot start without.
  assert.ok(fs.existsSync(path.join(deployed, 'bun', 'bun.exe')), 'bun/bun.exe is missing');
  assert.ok(fs.existsSync(path.join(deployed, 'claude-code', 'dist', 'cli-bun.js')),
    'claude-code/dist/cli-bun.js is missing');
});
