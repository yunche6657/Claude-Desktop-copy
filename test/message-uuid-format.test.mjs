// Transcript row ids must be canonical UUIDs, and old ones must keep working.
//
// Why the shape matters: the shipped frontend gates the message menu on a UUID regex
// (c06cf64bb-CdJdJuVd.js, function `jN` + variable `ps`):
//
//   var ps=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
//   function jN(e){ return e.waitingLane!=="parked" && ps.test(e.id) }
//
// Rows used to be built as "${sessionId}-${n}", which never matches. Measured on a
// running replica before this change: 6 rows, canonicalCount 0, and the message context
// menu offered only copy / copy-as-markdown / attach-as-context -- no "Rewind to here".
//
// The old scheme ALSO produced duplicate ids: every row of a turn computed its suffix
// from the same stale `existing.length`, so a turn with tool calls emitted the same uuid
// two or three times (measured: 6 rows / 3 unique ids). Nothing had noticed because
// nothing compared ids -- but a duplicate id makes "rewind to THIS message" ambiguous.
//
// The second half of this file is the compatibility boundary that made the change safe:
// .data/sessions holds real conversations whose ids are in the OLD format. Those rows are
// never rewritten (no migration), and reading is format-agnostic, so an old transcript
// still renders, rewinds and forks -- and a NEW turn appended to it links onto the old
// row and uses a canonical id itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSessionKernel } = require(path.join(ROOT, 'desktop', 'session-kernel.cjs'));

/** The exact regex the shipped frontend uses to decide a message is rewindable. */
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeKernel(storePath) {
  return createSessionKernel({
    emit: () => {},
    log: () => {},
    ...(storePath ? { storePath } : {}),
    createAgent: () => ({
      model: 'stub',
      tools: [],
      async run() { return { text: 'ok', stopReason: 'end_turn' }; },
    }),
  });
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uuid-'));
  return { dir, storePath: path.join(dir, 'store.json') };
}

// ---------------------------------------------------------------------------
// New rows must be canonical, unique, and chained.
// ---------------------------------------------------------------------------

test('every generated transcript row has a canonical 8-4-4-4-12 uuid', async () => {
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  await kernel.sendMessage(s.sessionId, 'first');
  await kernel.sendMessage(s.sessionId, 'second');

  const rows = kernel.getTranscript(s.sessionId);
  assert.ok(rows.length >= 4, 'expected at least four rows, got ' + rows.length);
  const offenders = rows.filter((row) => !CANONICAL.test(row.uuid));
  assert.deepEqual(offenders.map((row) => row.uuid), [],
    'these row uuids would be gated out of the rewind menu');
});

test('row uuids are unique inside a single turn', async () => {
  // The old scheme derived every row of a turn from one stale length, so a turn with
  // tool calls repeated the same id. Rewind-by-uuid cannot be unambiguous then.
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  await kernel.sendMessage(s.sessionId, 'only turn');

  const rows = kernel.getTranscript(s.sessionId);
  const uuids = rows.map((row) => row.uuid);
  assert.equal(new Set(uuids).size, uuids.length,
    'duplicate row uuids: ' + JSON.stringify(uuids));
});

test('parentUuid still chains every row to its predecessor', async () => {
  // Random ids must not break the chain: fork and rewind both walk it.
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  await kernel.sendMessage(s.sessionId, 'one');
  await kernel.sendMessage(s.sessionId, 'two');

  const rows = kernel.getTranscript(s.sessionId);
  assert.equal(rows[0].parentUuid, null, 'the first row must not have a parent');
  for (let i = 1; i < rows.length; i += 1) {
    assert.equal(rows[i].parentUuid, rows[i - 1].uuid,
      'row ' + i + ' does not chain onto its predecessor');
  }
});

test('the parent of every row resolves inside the transcript', async () => {
  // A chain can look right positionally while pointing at a uuid that is not present.
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  await kernel.sendMessage(s.sessionId, 'a');
  await kernel.sendMessage(s.sessionId, 'b');

  const rows = kernel.getTranscript(s.sessionId);
  const present = new Set(rows.map((row) => row.uuid));
  const dangling = rows
    .filter((row) => row.parentUuid !== null && row.parentUuid !== undefined)
    .filter((row) => !present.has(row.parentUuid));
  assert.deepEqual(dangling.map((row) => row.uuid), [], 'these rows point at a missing parent');
});

// ---------------------------------------------------------------------------
// The compatibility boundary: old-format rows are read as-is, never migrated.
// ---------------------------------------------------------------------------

/** A store in the PREVIOUS format: ids are "${sessionId}-${n}". */
function writeLegacyStore(storePath) {
  const sessionId = 'local_11111111-2222-4333-8444-555555555555';
  const row = (n, type, role, text, parentUuid) => ({
    parentUuid,
    isSidechain: false,
    promptId: sessionId,
    type,
    message: { role, content: [{ type: 'text', text }] },
    uuid: sessionId + '-' + n,
    timestamp: '2026-01-0' + (n + 1) + 'T00:00:00.000Z',
    cwd: '/tmp/legacy',
    sessionId,
    version: '2.42304.0',
  });
  const transcripts = [];
  transcripts.push(row(0, 'user', 'user', 'legacy question', null));
  transcripts.push(row(1, 'assistant', 'assistant', 'legacy answer', sessionId + '-0'));
  const payload = {
    version: 2,
    savedAt: '2026-01-01T00:00:00.000Z',
    // workingDir/originCwd are present because load() backfills them when missing and
    // then persists (a pre-existing behaviour, not part of this change). Supplying them
    // keeps this fixture byte-stable so the assertion below is about ids, not backfill.
    sessions: [{
      sessionId,
      cwd: '/tmp/legacy',
      workingDir: '/tmp/legacy',
      originCwd: '/tmp/legacy',
      title: 'legacy chat',
      isRunning: false,
    }],
    transcripts: { [sessionId]: transcripts },
  };
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(payload, null, 2));
  return { sessionId, legacyUuids: transcripts.map((entry) => entry.uuid) };
}

test('a store written by the previous build loads unchanged', () => {
  const { dir, storePath } = tempStore();
  try {
    const { sessionId, legacyUuids } = writeLegacyStore(storePath);
    const kernel = makeKernel(storePath);

    const record = kernel.getSession(sessionId);
    assert.ok(record, 'the legacy session did not load at all');
    assert.equal(record.title, 'legacy chat');

    const rows = kernel.getTranscript(sessionId);
    assert.equal(rows.length, legacyUuids.length, 'the legacy transcript lost rows');
    // The exact ids are preserved. A migration here would be a silent rewrite of
    // someone's history, so the assertion names each id rather than counting them.
    assert.deepEqual(rows.map((row) => row.uuid), legacyUuids);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loading a legacy store does not rewrite it on disk', () => {
  // Reading must not migrate. A load that silently replaced ids would corrupt every
  // parentUuid that referenced the old value, and the user could not tell it happened.
  const { dir, storePath } = tempStore();
  try {
    const { legacyUuids } = writeLegacyStore(storePath);
    const before = fs.readFileSync(storePath, 'utf8');
    const kernel = makeKernel(storePath);
    kernel.getAll();
    kernel.flush();
    const after = fs.readFileSync(storePath, 'utf8');
    assert.equal(after, before, 'loading rewrote the store');
    assert.deepEqual(legacyUuids.filter((uuid) => !after.includes(uuid)), [],
      'these legacy ids were replaced on disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new turn on a legacy session keeps the old rows and chains onto them', async () => {
  // The mixed case that actually happens after upgrading: old rows below, new rows
  // appended. The first new row must parent onto the last OLD row.
  const { dir, storePath } = tempStore();
  try {
    const { sessionId, legacyUuids } = writeLegacyStore(storePath);
    const kernel = makeKernel(storePath);
    await kernel.sendMessage(sessionId, 'new question after upgrade');

    const rows = kernel.getTranscript(sessionId);
    assert.ok(rows.length > legacyUuids.length, 'the new turn appended nothing');

    // Old rows survive verbatim and in order.
    assert.deepEqual(rows.slice(0, legacyUuids.length).map((row) => row.uuid), legacyUuids);

    // The first appended row links onto the last legacy row, not onto null.
    const appended = rows.slice(legacyUuids.length);
    assert.equal(appended[0].parentUuid, legacyUuids[legacyUuids.length - 1],
      'the new turn did not chain onto the legacy transcript');

    // And the appended rows use the new canonical format.
    assert.deepEqual(appended.filter((row) => !CANONICAL.test(row.uuid)).map((row) => row.uuid), [],
      'a row appended after the upgrade is not canonical');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mixed transcript has no dangling parent after the append', async () => {
  const { dir, storePath } = tempStore();
  try {
    const { sessionId } = writeLegacyStore(storePath);
    const kernel = makeKernel(storePath);
    await kernel.sendMessage(sessionId, 'continue');

    const rows = kernel.getTranscript(sessionId);
    const present = new Set(rows.map((row) => row.uuid));
    const dangling = rows
      .filter((row) => row.parentUuid !== null && row.parentUuid !== undefined)
      .filter((row) => !present.has(row.parentUuid));
    assert.deepEqual(dangling.map((row) => row.uuid), [],
      'an old row no longer resolves after a new turn was appended');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy uuid still resolves as a rewind target', async () => {
  // The user-visible promise of the compatibility layer: an old conversation can be
  // rewound. Lookup is by opaque string, so an old id works exactly like a new one.
  const { dir, storePath } = tempStore();
  try {
    const { sessionId, legacyUuids } = writeLegacyStore(storePath);
    const kernel = makeKernel(storePath);
    // Rewind to the first (legacy) row.
    kernel.setTranscript(sessionId, kernel.getTranscript(sessionId).slice(0, 1));
    const rows = kernel.getTranscript(sessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uuid, legacyUuids[0], 'the legacy anchor row changed identity');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The gate itself: our ids must pass the shipped regex.
// ---------------------------------------------------------------------------

test('the shipped gate regex accepts a freshly generated row id', async () => {
  // This is the actual consumer contract. If this ever fails the menu item disappears
  // again, and no other test in the suite would notice.
  const kernel = makeKernel();
  const s = kernel.start({ cwd: process.cwd() });
  await kernel.sendMessage(s.sessionId, 'gate check');
  const first = kernel.getTranscript(s.sessionId)[0];
  // Mirrors jN(): a row is rewindable when its id matches and the lane is not parked.
  assert.equal(CANONICAL.test(first.uuid), true,
    'a generated row id would be gated out of the rewind menu: ' + first.uuid);
});

test('a legacy row id is still rejected by the gate, so the limitation is documented', () => {
  // Honest statement of what the change does NOT fix: conversations written by the
  // previous build keep non-canonical ids, so their messages stay non-rewindable until
  // they gain new rows. Migrating them would be a rewrite of user history, which this
  // change deliberately does not do.
  const legacy = 'local_11111111-2222-4333-8444-555555555555-0';
  assert.equal(CANONICAL.test(legacy), false);
});
