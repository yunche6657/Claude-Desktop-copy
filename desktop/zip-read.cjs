// Minimal read-only ZIP reader, used by the skills upload path.
//
// The upload dialog hands the main process a base64 ZIP (or .skill archive) and the
// app must unpack it into the skill directory. Node has no ZIP support in core, and
// this project only has `unzipper` as a devDependency — depending on a dev package
// from the runtime is how a packaged build breaks, so the format is read directly:
//
//   end-of-central-directory (scan back for 0x06054b50)
//     -> central directory entries (0x02014b50)
//       -> local file headers (0x04034b50) + deflate (0x0008) via zlib.inflateRawSync
//
// Only what the upload path needs: no encryption, no ZIP64, no spanning, no
// symlinks. Anything unsupported is reported as an error rather than half-extracted.
'use strict';

const zlib = require('node:zlib');

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Total extracted bytes allowed for one archive. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
/** Entries allowed for one archive. */
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Read every file entry from a ZIP buffer.
 *
 * @param {Buffer} buffer the archive
 * @param {{maxBytes?: number, maxEntries?: number}} [limits]
 * @returns {{entries: Array<{name: string, data: Buffer}>, skipped: Array<{name: string, reason: string}>}}
 */
function readZip(buffer, limits = {}) {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('not a zip archive');

  // The end-of-central-directory record sits in the last 64 KiB + 22 bytes.
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip end-of-central-directory not found');

  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const entries = [];
  const skipped = [];
  let consumed = 0;
  let offset = cdOffset;

  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== CENTRAL) break;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) { skipped.push({ name, reason: 'encrypted' }); continue; }
    if (name.endsWith('/')) continue; // directory entry
    if (entries.length >= maxEntries) { skipped.push({ name, reason: 'too many entries' }); continue; }
    if (localOffset + 30 > buffer.length) { skipped.push({ name, reason: 'truncated' }); continue; }
    if (buffer.readUInt32LE(localOffset) !== LOCAL) { skipped.push({ name, reason: 'bad local header' }); continue; }

    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) { skipped.push({ name, reason: 'truncated' }); continue; }

    const raw = buffer.subarray(dataStart, dataEnd);
    let data;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressedSize || maxBytes) });
      else { skipped.push({ name, reason: `unsupported method ${method}` }); continue; }
    } catch {
      skipped.push({ name, reason: 'inflate failed' });
      continue;
    }

    consumed += data.length;
    if (consumed > maxBytes) { skipped.push({ name, reason: 'archive too large' }); break; }
    entries.push({ name, data });
  }

  return { entries, skipped };
}

/**
 * Normalise an archive member name into a relative path that cannot escape its root.
 *
 * @param {string} name
 * @returns {string|null} a safe relative path, or null when the entry is refused
 */
function safeEntryPath(name) {
  const parts = String(name || '').replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..' || /^[A-Za-z]:$/.test(p))) return null;
  return parts.join('/');
}

/**
 * Find the SKILL.md entry, preferring the shallowest one.
 *
 * @param {Array<{name: string, data: Buffer}>} entries
 * @returns {{entry: {name: string, data: Buffer}, prefix: string}|null}
 */
function findManifest(entries) {
  const matches = entries
    .map((entry) => ({ entry, safe: safeEntryPath(entry.name) }))
    .filter((x) => x.safe && /(^|\/)SKILL\.md$/i.test(x.safe))
    .sort((a, b) => a.safe.split('/').length - b.safe.split('/').length);
  if (matches.length === 0) return null;
  const best = matches[0];
  const prefix = best.safe.replace(/SKILL\.md$/i, '');
  return { entry: best.entry, prefix };
}

module.exports = { DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, findManifest, readZip, safeEntryPath };
