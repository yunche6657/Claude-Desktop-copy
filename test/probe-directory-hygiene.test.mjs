// The probe directory is a working tool, not a scratch pad — it must not accumulate.
//
// Measured before this round: 148 probes, 35 of them `_`-prefixed throwaway scripts from
// single investigations. 32 of those were referenced nowhere in the repository, evidence log
// included; they were removed (31.8 KB). The three kept are named in STATUS.md / handoff
// documents and must stay: _e2e-landing-send, _login-needs, _ui-selectors.
//
// Left unchecked the directory grows by one or two files per round, which makes the useful
// probes impossible to find and makes `grep tools/probes` return mostly dead code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_DIR = path.join(ROOT, 'tools', 'probes');

function probes() {
  return fs.readdirSync(PROBE_DIR).filter((f) => f.endsWith('.mjs'));
}

/** Every text file in the repo except the probe directory itself. */
function repositoryText() {
  const parts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.data', 'probes', 'ion-dist'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|cjs|js|json|md)$/.test(entry.name)) {
        try { parts.push(fs.readFileSync(full, 'utf8')); } catch { /* unreadable is not fatal */ }
      }
    }
  };
  walk(ROOT);
  return parts.join('\n');
}

test('the probe directory stays under a size that can still be searched', () => {
  // A ceiling rather than an exact number: useful probes get added, dead ones must be removed.
  const count = probes().length;
  assert.ok(count <= 130, 'the probe directory has grown to ' + count + ' files; prune it');
});

test('no ad-hoc probe is left behind without a reference', () => {
  // `_` marks a throwaway written for one investigation. It must either be cited somewhere
  // (so it is reproducible evidence) or deleted.
  const text = repositoryText();
  const orphans = probes()
    .filter((f) => f.startsWith('_'))
    .filter((f) => !text.includes(f));
  assert.deepEqual(orphans, [], 'unreferenced ad-hoc probes: ' + orphans.join(', '));
});

test('probes do not come in numbered families', () => {
  // foo.mjs / foo2.mjs / foo3.mjs is the signature of iterating in place instead of editing.
  const groups = new Map();
  for (const f of probes()) {
    const base = f.replace(/\.mjs$/, '').replace(/[0-9]+$/, '');
    groups.set(base, (groups.get(base) || []).concat(f));
  }
  const families = [...groups.entries()].filter(([, v]) => v.length > 1).map(([k]) => k);
  // One reviewed exception remains: bp-send / bp-send2 are both cited in the evidence log.
  assert.deepEqual(families, ['bp-send'], 'numbered probe families: ' + families.join(', '));
});

test('every probe is either a runnable script or a documented helper', () => {
  // Two legitimate shapes live here:
  //   - a runnable probe: imports the CDP helper and drives the app
  //   - a shared helper: exports functions other probes import (pointer.mjs)
  // What must not exist is an empty or half-written file that looks like evidence.
  for (const f of probes()) {
    const text = fs.readFileSync(path.join(PROBE_DIR, f), 'utf8');
    const hasImport = /\bimport\b|require\(/.test(text);
    const hasExport = /\bexport\b/.test(text);
    assert.ok(hasImport || hasExport,
      f + ' neither imports the harness nor exports anything usable');
    assert.ok(text.length > 200, f + ' is too short to be a real probe (' + text.length + ' bytes)');
  }
});
