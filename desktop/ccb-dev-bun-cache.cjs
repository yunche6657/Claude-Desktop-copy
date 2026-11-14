'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function digest(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

// Each writer publishes its own verified immutable file. No writer replaces a
// file another process may be executing; interrupted writes remain .tmp files.
function prepareDevBun(source, projectRoot, cacheRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'claude-code-desktop', 'bun-cache')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'agent-core', 'manifest.json'), 'utf8'));
  const expected = manifest?.bun?.sha256?.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('CCB kernel: invalid pinned Bun SHA-256 in manifest');
  if (digest(source) !== expected) throw new Error('CCB kernel: bundled Bun SHA-256 does not match manifest');
  const directory = path.join(cacheRoot, expected);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of fs.readdirSync(directory)) {
    if (!/^bun-[0-9a-f-]+\.exe$/i.test(name)) continue;
    const candidate = path.join(directory, name);
    try { if (digest(candidate) === expected) return candidate; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const id = randomUUID();
  const temporary = path.join(directory, `bun-${id}.tmp`);
  const destination = path.join(directory, `bun-${id}.exe`);
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    if (digest(temporary) !== expected || digest(source) !== expected) throw new Error('CCB kernel: Bun source or cache SHA-256 changed during copy');
    fs.renameSync(temporary, destination);
    return destination;
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { prepareDevBun };
