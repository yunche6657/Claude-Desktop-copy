// Minimal ASAR reader/writer.
//
// The format is documented by Electron and is simple enough to implement without
// pulling a dependency into a build that otherwise has exactly one:
//
//   [ 4-byte LE uint32: header pickle size ]
//   [ 4-byte LE uint32: payload size ]
//   [ 4-byte LE uint32: header string length + 4 (the pickle's own size field) ]
//   [ 4-byte LE uint32: header JSON length ]
//   [ header JSON, padded to a 4-byte boundary ]
//   [ file contents, concatenated at the offsets the header names ]
//
// Writing this directly means the packaging step has no supply-chain surface and
// the tests can read a block back without Electron.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HEADER_PADDING = 4;

function align4(n) {
  return n + ((4 - (n % HEADER_PADDING)) % HEADER_PADDING);
}

/**
 * Collects every regular file under `roots`, returning paths relative to the
 * package root with forward slashes (the form ASAR headers use on all platforms).
 */
function collectFiles(rootDir, roots, { exclude = [] } = {}) {
  const files = [];
  const excluded = new Set(exclude.map(entry => entry.replace(/\\/g, '/')));

  const isExcluded = rel => {
    for (const pattern of excluded) {
      if (rel === pattern || rel.startsWith(pattern + '/')) return true;
      if (pattern.endsWith('*') && rel.startsWith(pattern.slice(0, -1))) return true;
    }
    return false;
  };

  const walk = (absolute, relBase) => {
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
      const rel = relBase.replace(/\\/g, '/');
      if (!isExcluded(rel)) files.push(rel);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(absolute)) {
      const childRel = relBase ? `${relBase}/${name}` : name;
      if (isExcluded(childRel.replace(/\\/g, '/'))) continue;
      walk(path.join(absolute, name), childRel);
    }
  };

  for (const root of roots) {
    const absolute = path.join(rootDir, root);
    if (!fs.existsSync(absolute)) continue;
    walk(absolute, root);
  }
  return files.sort();
}

/** Builds the nested header object ASAR expects from a flat relative-path list. */
function buildHeaderTree(relativePaths) {
  const root = { files: {} };
  for (const rel of relativePaths) {
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      node.files[part] = node.files[part] || {};
      if (last) node.files[part].size = 0; // filled in during the write
      else node.files[part].files = node.files[part].files || {};
      node = node.files[part];
    }
  }
  return root;
}

/**
 * Writes an ASAR archive. Returns { bytes, fileCount, header }.
 *
 * Header layout, verified against the shipped app.asar's own first 16 bytes
 * (u32@0 = 4, u32@4 = pickle size, u32@8 = JSON length + 4, u32@12 = JSON length):
 *
 *   0  u32  pickle header length, always 4
 *   4  u32  total pickle size (JSON length + 8, padded)
 *   8  u32  JSON length + 4
 *  12  u32  JSON length
 *  16  JSON, padded to 4 bytes
 *      payload
 *
 * Reading with the JSON at 16 is what Electron does, so the writer must put it
 * there; an earlier version wrote it at 12 and the archive was unreadable.
 */
function createAsar(rootDir, relativePaths, { outFile } = {}) {
  const header = buildHeaderTree(relativePaths);
  const chunks = [];
  let offset = 0;

  // Assign offsets in the same order the header was built (sorted), so the
  // header and payload cannot disagree.
  const sorted = [...relativePaths].sort();
  for (const rel of sorted) {
    const absolute = path.join(rootDir, rel);
    const bytes = fs.readFileSync(absolute);
    let node = header;
    for (const part of rel.split('/')) node = node.files[part];
    node.size = bytes.length;
    node.offset = String(offset);
    const blockSize = 4 * 1024 * 1024;
    const blocks = [];
    for (let start = 0; start < bytes.length; start += blockSize) {
      blocks.push(crypto.createHash('sha256').update(bytes.subarray(start, start + blockSize)).digest('hex'));
    }
    // @electron/asar flushes the final (possibly empty) block as well.
    if (bytes.length % blockSize === 0) blocks.push(crypto.createHash('sha256').digest('hex'));
    node.integrity = {
      algorithm: 'SHA256',
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      blockSize,
      blocks,
    };
    chunks.push(bytes);
    offset += bytes.length;
  }

  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const jsonLength = headerJson.length;
  const paddedJsonLength = align4(jsonLength);
  const headerPadding = Buffer.alloc(paddedJsonLength - jsonLength);

  // Field arithmetic, measured from the shipped archive:
  //   jsonLen           136222
  //   u32@8 = jsonLen + 6   (136228)  the pickle's declared body size
  //   u32@4 = jsonLen + 10  (136232)  u32@8 + 4
  //   payload starts at 16 + align4(jsonLen) = 136240, i.e. u32@4 + 8
  //
  // So neither u32@4 nor u32@8 is the payload offset; both describe the pickle
  // body, and the payload follows a fixed 8-byte gap past u32@4. Writing the
  // payload at u32@4 was the defect that made Electron report "Invalid package".
  const dataStart = 16 + paddedJsonLength;
  // u32@8 is jsonLen + pad + 4, and u32@4 is that value + 4.
  const pickleBodySize = jsonLength + (paddedJsonLength - jsonLength) + 4;
  const fields = Buffer.alloc(16);
  fields.writeUInt32LE(4, 0);
  fields.writeUInt32LE(pickleBodySize + 4, 4);
  fields.writeUInt32LE(pickleBodySize, 8);
  fields.writeUInt32LE(jsonLength, 12);

  const payload = Buffer.concat(chunks);
  const total = Buffer.concat([fields, headerJson, headerPadding, payload]);

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, total);
  }

  return { bytes: total, fileCount: sorted.length, header, headerSize: dataStart };
}

/** Reads an ASAR archive back. Returns { header, files: Map<rel, Buffer> }. */
function readAsar(file) {
  const buffer = fs.readFileSync(file);
  // The payload starts at 16 + align4(jsonLength). Verified against the shipped
  // app.asar: jsonLength 136222 -> payload at 136240, which is u32@4 + 8. The
  // u32@4 and u32@8 fields describe the pickle body, not the payload offset.
  const jsonLength = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.toString('utf8', 16, 16 + jsonLength));
  const dataStart = 16 + align4(jsonLength);

  const files = new Map();
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.files) { walk(entry, rel); continue; }
      const size = Number(entry.size);
      const offset = Number(entry.offset);
      files.set(rel, buffer.subarray(dataStart + offset, dataStart + offset + size));
    }
  };
  walk(header, '');
  return { header, files, dataStart };
}

module.exports = { align4, collectFiles, buildHeaderTree, createAsar, readAsar };
