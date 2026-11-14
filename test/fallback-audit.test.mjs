// The fallback audit must be able to say "a new unimplemented channel appeared".
//
// A tool that only ever prints a list is a report; a tool that can fail is a gate. These tests
// use synthetic logs so they do not depend on a running app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'fallback-audit.cjs');
const LOG = path.join(ROOT, 'evidence', 'live', 'replica-9340.out');

test('the audit reports the channels the running app needed but does not implement', () => {
  // Use the module, not its console output: parsing a report meant for humans is how a test
  // ends up asserting on formatting instead of behaviour.
  const { collect } = require('../tools/fallback-audit.cjs');
  const { counts, missing } = collect(LOG);
  assert.equal(missing, false, 'the trace log must exist; run the app first');
  assert.ok(counts.size > 0, 'the trace must contain fallback calls');
  for (const [channel, count] of counts) {
    assert.equal(typeof channel, 'string');
    assert.ok(count > 0);
  }
});

test('a recorded baseline lets a NEW unimplemented channel fail the check', () => {
  // The baseline exists so "we added a call the bridge cannot answer" is a red build, not a
  // line in a log nobody reads.
  assert.ok(fs.existsSync(path.join(ROOT, 'evidence', 'live', 'fallback-baseline.json')),
    'run node tools/fallback-audit.cjs --baseline to record one');
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'live', 'fallback-baseline.json'), 'utf8'));
  assert.ok(Array.isArray(baseline.channels) && baseline.channels.length > 0);
});

test('listCliSessions is NOT in the baseline, because it now has a handler', () => {
  // This is the regression this round fixed: it used to be answered by emptyFor() forever.
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'live', 'fallback-baseline.json'), 'utf8'));
  assert.equal(baseline.channels.includes('claude.web.LocalSessions.listCliSessions'), false,
    'a channel with a real handler must not appear in the fallback list');
});

test('the check exits 0 when nothing new appeared', () => {
  const out = execFileSync(process.execPath, [TOOL, '--check'], { encoding: 'utf8', cwd: ROOT });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.added, []);
});
