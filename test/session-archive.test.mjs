// Session archive and resume-policy tests.
//
// The resume decision is the part with real consequences: getting it wrong
// either silently appends to a finished conversation or discards history the
// user expected to keep. Both directions are asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const {
  shouldResume, normaliseId, sameSession, transcriptFileName,
  SessionArchive, resumeEnvironment,
  SESSIONS_DIR, FILE_PREFIX, ARCHIVE_INDEX,
} = await import('../desktop/session-archive.cjs');

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'sess-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('names match the observed constants', () => {
  assert.equal(SESSIONS_DIR, 'claude-code-sessions');
  assert.equal(FILE_PREFIX, 'local_');
  assert.equal(ARCHIVE_INDEX, 'archived-sessions.idx');
});

test('session ids are normalised by stripping cse_ and session_', () => {
  assert.equal(normaliseId('cse_abc'), 'abc');
  assert.equal(normaliseId('session_abc'), 'abc');
  assert.equal(normaliseId('abc'), 'abc');
  assert.equal(normaliseId(''), '');
  assert.equal(normaliseId(null), '');
  // Only one prefix is stripped, and only at the start.
  assert.equal(normaliseId('cse_session_abc'), 'session_abc');
  assert.equal(normaliseId('x_cse_abc'), 'x_cse_abc');
});

test('sameSession ignores prefixes but never matches empty ids', () => {
  assert.ok(sameSession('cse_abc', 'session_abc'));
  assert.ok(sameSession('abc', 'cse_abc'));
  assert.ok(!sameSession('abc', 'abd'));
  assert.ok(!sameSession('', ''));
  assert.ok(!sameSession('cse_', 'session_'), 'empty after stripping must not match');
});

test('transcript file names carry the local_ prefix', () => {
  assert.equal(transcriptFileName('abc'), 'local_abc.json');
  assert.equal(transcriptFileName('cse_abc'), 'local_abc.json');
});

test('a non-remote-control session always starts fresh', () => {
  for (const session of [
    { resumesTranscript: true, hasCompletedTurns: true },
    { resumesTranscript: false, hasCompletedTurns: false },
  ]) {
    const result = shouldResume(session);
    assert.equal(result.resume, false, JSON.stringify(session));
    assert.match(result.reason, /starts fresh/);
  }
});

test('a remote-control session resumes when it resumes its transcript', () => {
  const result = shouldResume(
    { resumesTranscript: true, hasCompletedTurns: true },
    { remoteControlSpawn: true },
  );
  assert.equal(result.resume, true);
  assert.match(result.reason, /resumes its transcript/);
});

test('an unfinished session resumes even without resumesTranscript', () => {
  const result = shouldResume(
    { resumesTranscript: false, hasCompletedTurns: false },
    { remoteControlSpawn: true },
  );
  assert.equal(result.resume, true, 'a session with no completed turn must be resumable');
  assert.match(result.reason, /never completed a turn/);
});

test('a finished session that does not resume its transcript starts fresh', () => {
  const result = shouldResume(
    { resumesTranscript: false, hasCompletedTurns: true },
    { remoteControlSpawn: true },
  );
  assert.equal(result.resume, false);
  assert.match(result.reason, /does not resume its transcript/);
});

test('a missing session cannot resume', () => {
  assert.equal(shouldResume(null, { remoteControlSpawn: true }).resume, false);
});

test('a transcript round-trips through the archive', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  const session = { id: 'abc', title: '测试', messages: [{ role: 'user', text: 'hi' }] };
  const file = archive.saveTranscript(session);

  assert.ok(existsSync(file));
  assert.equal(path.basename(file), 'local_abc.json');
  assert.equal(path.dirname(file), path.join(root, SESSIONS_DIR));

  const loaded = archive.loadTranscript('cse_abc');
  assert.equal(loaded.title, '测试');
  assert.deepEqual(loaded.messages, session.messages);
  assert.ok(archive.hasTranscript('session_abc'));
}));

test('loading a missing or corrupt transcript returns null', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  assert.equal(archive.loadTranscript('nope'), null);

  archive.ensureDir();
  writeFileSync(path.join(archive.sessionsDir, transcriptFileName('bad')), '{not json');
  assert.equal(archive.loadTranscript('bad'), null);
}));

test('an oversized transcript is refused', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  const huge = { id: 'big', messages: [{ text: 'x'.repeat(11 * 1024 * 1024) }] };
  assert.throws(() => archive.saveTranscript(huge), /exceeds the .* limit/);
}));

test('a session without an id is refused', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  assert.throws(() => archive.saveTranscript({}), /id is required/);
  assert.throws(() => archive.saveTranscript(null), /id is required/);
}));

test('archive moves a session out of the live list but keeps the transcript', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  archive.saveTranscript({ id: 'abc', title: '保留', messages: [] });

  archive.archive('abc');
  assert.ok(archive.isArchived('abc'));
  assert.ok(archive.isArchived('cse_abc'), 'isArchived must normalise');
  assert.ok(archive.hasTranscript('abc'), 'the transcript must survive archiving');

  const listed = archive.listArchived();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'abc');
  assert.equal(listed[0].title, '保留');
  assert.equal(listed[0].hasTranscript, true);
}));

test('archiving twice does not duplicate the index entry', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  archive.archive('abc');
  archive.archive('cse_abc');
  assert.equal(archive.listArchived().length, 1);
}));

test('archiving a session with no transcript is recorded honestly', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  archive.archive('ghost', { title: '没有记录' });
  const entry = archive.listArchived()[0];
  assert.equal(entry.hasTranscript, false);
  assert.equal(entry.title, '没有记录');
}));

test('unarchive removes the entry and reports a miss clearly', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  archive.archive('abc');
  assert.deepEqual(archive.unarchive('cse_abc'), { ok: true, id: 'abc' });
  assert.equal(archive.isArchived('abc'), false);
  assert.deepEqual(archive.unarchive('abc'), { ok: false, reason: 'not-archived' });
}));

test('a corrupt index reads as empty and the next write repairs it', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  archive.ensureDir();
  writeFileSync(archive.indexPath, 'not json at all');
  assert.deepEqual(archive.readIndex(), []);

  archive.archive('abc');
  const repaired = JSON.parse(readFileSync(archive.indexPath, 'utf8'));
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].id, 'abc');
}));

test('an index that is valid JSON but not an array also reads as empty', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  archive.ensureDir();
  writeFileSync(archive.indexPath, '{"not":"an array"}');
  assert.deepEqual(archive.readIndex(), []);
}));

test('index entries without a string id are dropped', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  archive.ensureDir();
  writeFileSync(archive.indexPath, JSON.stringify([{ id: 'ok' }, { id: 42 }, null, {}]));
  assert.deepEqual(archive.readIndex().map(entry => entry.id), ['ok']);
}));

test('deleting a transcript removes only that file', () => withRoot(async root => {
  const archive = new SessionArchive(root);
  archive.saveTranscript({ id: 'a', messages: [] });
  archive.saveTranscript({ id: 'b', messages: [] });

  assert.deepEqual(archive.deleteTranscript('a'), { ok: true });
  assert.equal(archive.hasTranscript('a'), false);
  assert.equal(archive.hasTranscript('b'), true);
  assert.deepEqual(archive.deleteTranscript('a'), { ok: false, reason: 'missing' });
}));

test('resumeEnvironment sets and clears the reattach variable', () => {
  const base = { PATH: '/usr/bin' };
  const withId = resumeEnvironment('cse_abc', base);
  assert.equal(withId.CLAUDE_BRIDGE_REATTACH_SESSION, 'abc');
  assert.equal(withId.PATH, '/usr/bin', 'the base environment must be preserved');

  const cleared = resumeEnvironment('', { ...base, CLAUDE_BRIDGE_REATTACH_SESSION: 'old' });
  assert.equal(cleared.CLAUDE_BRIDGE_REATTACH_SESSION, undefined);
  assert.ok(!('CLAUDE_BRIDGE_REATTACH_SESSION' in cleared));
});
