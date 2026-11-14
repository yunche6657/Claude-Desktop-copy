'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The fixed desktop stages unrestricted 3p uploads under userData.
async function savePendingUpload({ userDataDir, content, fileName, isCurrent }) {
  const current = () => { try { return typeof isCurrent === 'function' && isCurrent() === true; } catch { return false; } };
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir) || !current()) return null;
  if (typeof content !== 'string' || typeof fileName !== 'string' || !fileName) return null;
  const name = path.basename(fileName);
  if (!name || name === '.' || name === '..') return null;
  const dir = path.join(userDataDir, 'pending-uploads');
  let target, created = false, committed = false;
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !current()) return null;
    target = path.join(dir, `${crypto.randomUUID()}-${name}`);
    const handle = await fs.promises.open(target, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(Buffer.from(content, 'base64')); }
    finally { await handle.close(); }
    if (!current()) return null;
    committed = true;
    return target;
  } catch { return null; }
  finally { if (created && !committed) await fs.promises.unlink(target).catch(() => {}); }
}
module.exports = { savePendingUpload };
