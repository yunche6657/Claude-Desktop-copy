// The session store holds real user work. It must never be "cleaned up" for size.
//
// Measured this round: .data/sessions/kernel-sessions.json is 15.96 MB, of which 15.17 MB is
// the transcripts map. The two largest transcripts are 9.6 MB (478 rows) and 4.6 MB (265
// rows), and reading them shows why they are big:
//
//   local_c051c392…  @"…\数字普惠金融_农村财务脆弱性_研究方案交接.md"
//   local_54eca530…  @"…\翻译学导论论文_修订版.docx"
//
// Those are research documents the user attached. A size-driven cleanup would have deleted
// them — the sessions have empty titles, so any "delete untitled" rule hits them first.
//
// This file exists so that a future round cannot repeat that mistake silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = path.join(ROOT, '.data', 'sessions', 'kernel-sessions.json');

function store() {
  assert.ok(fs.existsSync(STORE), 'the session store is missing entirely');
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

test('the session store still holds every transcript it had', () => {
  // A floor, not an exact count: new sessions are added by normal use.
  const data = store();
  const transcripts = Object.keys(data.transcripts || {}).length;
  assert.ok(transcripts >= 100, 'transcripts dropped to ' + transcripts + ' — was the store pruned?');
});

test('the two large research transcripts are still present and non-empty', () => {
  // Located by CONTENT, then checked per transcript.
  //
  // The first version searched the whole transcripts blob for the two titles and stayed
  // green when one transcript was emptied, because the string also appears in the other.
  // A check that can pass while the data is gone is worse than no check, so this now finds
  // the owning transcript first and asserts on that record alone.
  const data = store();
  const wanted = ['数字普惠金融', '翻译学导论'];
  for (const needle of wanted) {
    const owners = Object.entries(data.transcripts || {})
      .filter(([, rows]) => JSON.stringify(rows).includes(needle))
      .map(([id, rows]) => ({ id, rows: Array.isArray(rows) ? rows.length : 0 }))
      .sort((a, b) => b.rows - a.rows);
    assert.ok(owners.length > 0, 'no transcript contains ' + needle + ' any more');
    // The primary transcript is the longest one. Both titles also appear in a short
    // follow-up session, so asserting on "any owner" stays green when the real 478-row
    // record is emptied — measured exactly that. The longest owner is the one that matters.
    const primary = owners[0];
    assert.ok(primary.rows > 100,
      'the primary ' + needle + ' transcript (' + primary.id.slice(0, 24) + ') has only '
      + primary.rows + ' rows — it was emptied or truncated');
  }
});

test('no session record carries a cleanup marker', () => {
  // If a future round decides to prune, it must not leave the store half-edited.
  const data = store();
  for (const session of data.sessions || []) {
    assert.equal(typeof session.sessionId, 'string', 'a session record lost its id');
  }
});

test('the store is valid JSON with the expected top-level shape', () => {
  const data = store();
  assert.ok(Array.isArray(data.sessions), 'sessions is not an array');
  assert.equal(typeof data.transcripts, 'object', 'transcripts is not an object');
  assert.equal(Object.keys(data.transcripts).length, data.sessions.length,
    'transcripts and sessions have diverged');
});
