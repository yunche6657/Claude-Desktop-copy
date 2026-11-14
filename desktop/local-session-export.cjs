'use strict';
// Local-only conversation export for the replica. This is NOT the official
// Claude account export format or a remote import/export implementation.
// It intentionally excludes attachments, binary tool data, and output files.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SESSIONS = 500;
const MAX_ENTRIES = MAX_SESSIONS + 1;
const OMITTED = '[Attachment or non-text content excluded from this export]';

function visibleContent(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
    if (item.type === 'tool_use') return '[Tool: ' + String(item.name || 'unknown') + ']';
    if (item.type === 'tool_result') return visibleContent(item.content) || OMITTED;
    return OMITTED;
  }).filter(Boolean).join('\n');
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeCutoff(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid export cutoff');
  return value;
}

function collect(kernel, cutoff = 0) {
  if (!kernel || typeof kernel.getAll !== 'function' || typeof kernel.getTranscript !== 'function') {
    throw new Error('local session export is unavailable');
  }
  const since = normalizeCutoff(cutoff);
  const sessions = kernel.getAll().filter(s => s && typeof s.sessionId === 'string'
    && Math.max(timestamp(s.lastActivityAt), timestamp(s.createdAt)) >= since);
  if (sessions.length > MAX_SESSIONS) throw new RangeError('export contains too many sessions');
  const rows = sessions.map((session, idx) => {
    const raw = kernel.getTranscript(session.sessionId);
    const transcript = (Array.isArray(raw) ? raw : []).filter(r => r && r.message).map(r => ({
      type: typeof r.type === 'string' ? r.type : 'unknown',
      timestamp: r.timestamp ?? null,
      uuid: typeof r.uuid === 'string' ? r.uuid : null,
      role: typeof r.message.role === 'string' ? r.message.role : null,
      content: visibleContent(r.message.content),
    }));
    return {
      // Fixed numeric filenames, never names or paths provided by the model.
      filename: 'sessions/session-' + String(idx + 1).padStart(4, '0') + '.json',
      data: {
        id: session.sessionId,
        title: typeof session.title === 'string' ? session.title : '',
        projectName: typeof session.cwd === 'string' ? path.basename(session.cwd) : '',
        createdAt: session.createdAt ?? null,
        lastActivityAt: session.lastActivityAt ?? null,
        transcript,
      },
    };
  });
  const files = rows.map(row => ({
    name: row.filename,
    body: Buffer.from(JSON.stringify(row.data, null, 2) + '\n', 'utf8'),
  }));
  const manifest = {
    format: 'claude-desktop-replica-local-conversations-v1',
    notOfficialClaudeExport: true,
    excludes: ['attachments', 'binary content', 'output files', 'Cowork tasks', 'remote chats'],
    count: files.length,
    sessions: rows.map(({filename, data}) => ({
      filename, id: data.id, title: data.title, projectName: data.projectName,
    })),
  };
  files.unshift({name: 'manifest.json', body: Buffer.from(JSON.stringify(manifest, null, 2) + '\n')});
  const sizeBytes = files.reduce((sum, file) => sum + file.body.length, 0);
  if (sizeBytes > MAX_BYTES) throw new RangeError('export exceeds the 64 MiB safety limit');
  return {count: sessions.length, byKind: {code: sessions.length, cowork: 0, chat: 0},
    sizeBytes, files};
}

const crcTable = Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1
    ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Small standards-compliant ZIP (stored method), with fixed, server-controlled
// paths. ZIP64 is unnecessary because this exporter has a 64 MiB cap.
function zipFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_ENTRIES) throw new RangeError('invalid ZIP entry count');
  const local = [], central = [];
  let offset = 0;
  for (const {name, body} of files) {
    if (!/^(manifest\.json|sessions\/session-\d{4}\.json)$/.test(name) || !Buffer.isBuffer(body)) {
      throw new TypeError('invalid ZIP entry');
    }
    const filename = Buffer.from(name, 'utf8');
    const sum = crc32(body);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 filenames
    h.writeUInt16LE(0, 8);      // stored
    h.writeUInt32LE(sum, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(body.length, 22);
    h.writeUInt16LE(filename.length, 26);
    local.push(h, filename, body);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(sum, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(body.length, 24);
    c.writeUInt16LE(filename.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, filename);
    offset += h.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(files.length, 8);
  footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(directory.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}

function createLocalSessionExporter({kernel, downloadsDir, reveal} = {}) {
  if (typeof downloadsDir !== 'string' || !path.isAbsolute(downloadsDir)) {
    throw new TypeError('export downloads directory must be an absolute path');
  }
  let active = null;
  const written = new Set();
  return {
    preview(cutoff) {
      const {count, byKind, sizeBytes} = collect(kernel, cutoff);
      return {count, byKind, sizeBytes};
    },
    async run(cutoff) {
      if (active) return {ok: false, errorCode: 'EXPORT_BUSY'};
      const operation = {cancelled: false};
      active = operation;
      let destination = null;
      try {
        const report = collect(kernel, cutoff);
        if (!report.count) return {ok: false, errorCode: 'NO_SESSIONS'};
        const zip = zipFiles(report.files);
        // Yield once to permit a queued cancel before the write begins.
        await Promise.resolve();
        if (operation.cancelled) return {ok: false, errorCode: 'CANCELLED'};
        fs.mkdirSync(downloadsDir, {recursive: true});
        if (fs.lstatSync(downloadsDir).isSymbolicLink()) {
          return {ok: false, errorCode: 'WRITE_FAILED'};
        }
        const dir = fs.realpathSync(downloadsDir);
        destination = path.join(dir, 'claude-replica-conversations-' +
          new Date().toISOString().slice(0, 10) + '-' + crypto.randomUUID().slice(0, 8) + '.zip');
        await fs.promises.writeFile(destination, zip, {flag: 'wx', mode: 0o600});
        if (operation.cancelled) {
          await fs.promises.unlink(destination).catch(() => {});
          return {ok: false, errorCode: 'CANCELLED'};
        }
        written.add(destination);
        return {ok: true, writtenPath: destination, count: report.count,
          sizeBytes: zip.length, skippedOutputs: 0};
      } catch {
        if (destination) await fs.promises.unlink(destination).catch(() => {});
        return {ok: false, errorCode: 'WRITE_FAILED'};
      } finally {
        if (active === operation) active = null;
      }
    },
    cancel() {
      if (!active) return false;
      active.cancelled = true;
      return true;
    },
    showInFolder(file) {
      // Never act as an arbitrary-path reveal primitive.
      if (!written.has(file) || !fs.existsSync(file) || typeof reveal !== 'function') return false;
      try { return reveal(file) !== false; } catch { return false; }
    },
  };
}
module.exports = {createLocalSessionExporter, collect, zipFiles, visibleContent};
