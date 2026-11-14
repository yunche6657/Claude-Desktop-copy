// Session archiving and resume policy.
//
// Two behaviours are taken from the shipped bundle:
//
//   1. Names and layout (index.chunk-lzaSYO3Q.js):
//        Md = "claude-code-sessions"   storage directory
//        Nd = "local_"                 filename prefix
//        vJe = "archived-sessions.idx" archive index
//
//   2. Resume policy (index.chunk-5wlbAX53.js):
//        d(e,t) = a(e) ? t.resumesTranscript || !t.hasCompletedTurns : false
//      A session may be reattached when it resumes its transcript, or when it
//      never completed a turn. A finished turn that does not resume its
//      transcript must start fresh instead of silently appending to history.
//
// This module owns the archive index and the resume decision. It does not talk
// to a model; it decides what to hand a new run.
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const SESSIONS_DIR = 'claude-code-sessions';
const FILE_PREFIX = 'local_';
const ARCHIVE_INDEX = 'archived-sessions.idx';
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024; // bJe = 10485760 in the bundle

/**
 * The resume decision.
 *
 * `session` describes the stored session: { resumesTranscript, hasCompletedTurns }.
 * Returns { resume: boolean, reason: string }.
 */
function shouldResume(session, { remoteControlSpawn = false } = {}) {
  if (!session) return { resume: false, reason: 'no session' };
  // `a(e)` in the bundle gates reattachment on the session being a remote
  // control spawn. Anything else always starts a fresh transcript.
  if (!remoteControlSpawn) {
    return { resume: false, reason: 'not a remote-control session; starts fresh' };
  }
  if (session.resumesTranscript) {
    return { resume: true, reason: 'session resumes its transcript' };
  }
  if (!session.hasCompletedTurns) {
    return { resume: true, reason: 'session never completed a turn' };
  }
  return { resume: false, reason: 'session is complete and does not resume its transcript' };
}

/** Session id normalisation: strips the `cse_` / `session_` prefixes. */
function normaliseId(id) {
  if (typeof id !== 'string') return '';
  return id.replace(/^(?:cse|session)_/, '');
}

/** True when two ids refer to the same session. */
function sameSession(a, b) {
  return normaliseId(a) === normaliseId(b) && normaliseId(a) !== '';
}

/** The file name a session's transcript is stored under. */
function transcriptFileName(sessionId) {
  return `${FILE_PREFIX}${normaliseId(sessionId)}.json`;
}

class SessionArchive {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.sessionsDir = path.join(this.rootDir, SESSIONS_DIR);
    this.indexPath = path.join(this.sessionsDir, ARCHIVE_INDEX);
  }

  ensureDir() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** Reads the archive index; a missing or corrupt index reads as empty. */
  readIndex() {
    if (!fs.existsSync(this.indexPath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(entry => entry && typeof entry.id === 'string');
    } catch {
      // A corrupt index must not stop the app from starting; it reads as empty
      // and the next write repairs it.
      return [];
    }
  }

  writeIndex(entries) {
    this.ensureDir();
    const temp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(entries, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, this.indexPath);
    } finally {
      if (fs.existsSync(temp)) { try { fs.unlinkSync(temp); } catch { /* best effort */ } }
    }
  }

  /** Stores a transcript. Returns the path written. */
  saveTranscript(session) {
    if (!session || typeof session.id !== 'string' || !session.id) {
      throw new Error('a session with an id is required');
    }
    const body = JSON.stringify(session, null, 2);
    if (Buffer.byteLength(body) > MAX_TRANSCRIPT_BYTES) {
      throw new Error(`transcript exceeds the ${MAX_TRANSCRIPT_BYTES}-byte limit`);
    }
    this.ensureDir();
    const file = path.join(this.sessionsDir, transcriptFileName(session.id));
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, body, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) { try { fs.unlinkSync(temp); } catch { /* best effort */ } }
    }
    return file;
  }

  loadTranscript(sessionId) {
    const file = path.join(this.sessionsDir, transcriptFileName(sessionId));
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed.id === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  hasTranscript(sessionId) {
    return fs.existsSync(path.join(this.sessionsDir, transcriptFileName(sessionId)));
  }

  /** Archives a session: it leaves the live list but its transcript is kept. */
  archive(sessionId, { title, archivedAt = new Date().toISOString() } = {}) {
    const explicit = !this.hasTranscript(sessionId);
    const transcript = explicit ? null : this.loadTranscript(sessionId);
    const entries = this.readIndex().filter(entry => !sameSession(entry.id, sessionId));
    entries.push({
      id: normaliseId(sessionId),
      title: title ?? transcript?.title ?? '',
      archivedAt,
      hasTranscript: !explicit,
    });
    this.writeIndex(entries);
    return { id: normaliseId(sessionId), archivedAt };
  }

  unarchive(sessionId) {
    const entries = this.readIndex();
    const next = entries.filter(entry => !sameSession(entry.id, sessionId));
    if (next.length === entries.length) return { ok: false, reason: 'not-archived' };
    this.writeIndex(next);
    return { ok: true, id: normaliseId(sessionId) };
  }

  isArchived(sessionId) {
    return this.readIndex().some(entry => sameSession(entry.id, sessionId));
  }

  listArchived() {
    return this.readIndex();
  }

  /** Deletes a transcript for good. */
  deleteTranscript(sessionId) {
    const file = path.join(this.sessionsDir, transcriptFileName(sessionId));
    if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
    fs.unlinkSync(file);
    return { ok: true };
  }
}

/**
 * Builds the environment a resumed run needs. The bundle passes the session id
 * through `CLAUDE_BRIDGE_REATTACH_SESSION`.
 */
function resumeEnvironment(sessionId, base = process.env) {
  const env = { ...base };
  if (sessionId) env.CLAUDE_BRIDGE_REATTACH_SESSION = normaliseId(sessionId);
  else delete env.CLAUDE_BRIDGE_REATTACH_SESSION;
  return env;
}

module.exports = {
  SESSIONS_DIR,
  FILE_PREFIX,
  ARCHIVE_INDEX,
  MAX_TRANSCRIPT_BYTES,
  shouldResume,
  normaliseId,
  sameSession,
  transcriptFileName,
  SessionArchive,
  resumeEnvironment,
};
