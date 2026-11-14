'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 8 * 1024 * 1024;
const ACCOUNT_MAX_BYTES = 256 * 1024;
const SEGMENT = /^[a-zA-Z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Native C2t/cC defaults to the full path and optionally latches short paths.
function createCoworkGlobalMemory({ userDataDir, getAccountContext, shortPaths = false }) {
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir) || typeof getAccountContext !== 'function') throw new TypeError('An absolute userDataDir and getAccountContext are required');
  const root = path.join(userDataDir, 'local-agent-mode-sessions');
  const selected = new Map();
  const valid = id => typeof id === 'string' && SEGMENT.test(id);
  const short = id => UUID.test(id) ? id.slice(0, 8).toLowerCase() : id;
  const exists = target => {
    try { fs.lstatSync(target); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  function accountRoot(accountId, orgId) {
    const full = path.join(root, accountId, orgId);
    if (!shortPaths) return full;
    const key = JSON.stringify([accountId, orgId]);
    if (selected.has(key)) return selected.get(key);
    const abbreviated = path.join(root, short(accountId), short(orgId));
    const result = exists(abbreviated) || !exists(full) ? abbreviated : full;
    selected.set(key, result);
    return result;
  }
  async function context() {
    const identity = await getAccountContext();
    return valid(identity?.accountId) && valid(identity?.orgId) ? identity : null;
  }
  // A host can bind an identity to its current account/configuration epoch.
  function current(identity) {
    try { return typeof identity?.isCurrent !== 'function' || identity.isCurrent() === true; }
    catch { return false; }
  }
  // The host supplies a trusted userDataDir; descendants must not be links.
  function checkDirectoryChain(target, create) {
    let current = userDataDir;
    for (const component of path.relative(userDataDir, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      if (create) {
        try { fs.mkdirSync(current, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid memory directory');
    }
  }
  async function readGlobalMemory() {
    const identity = await context();
    if (!identity || !current(identity)) return null;
    try {
      const dir = path.join(accountRoot(identity.accountId, identity.orgId), 'memory');
      checkDirectoryChain(dir, false);
      const file = path.join(dir, 'CLAUDE.md');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return null;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const actual = fs.fstatSync(fd);
        if (!actual.isFile() || actual.size > MAX_BYTES) return null;
        const data = fs.readFileSync(fd);
        return data.length <= MAX_BYTES && current(identity) ? data.toString('utf8') : null;
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  }
  async function writeGlobalMemory(content) {
    const identity = await context();
    if (!identity || !current(identity) || typeof content !== 'string') return false;
    let tmp;
    try {
      const dir = path.join(accountRoot(identity.accountId, identity.orgId), 'memory');
      checkDirectoryChain(dir, true);
      const file = path.join(dir, 'CLAUDE.md');
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      tmp = path.join(dir, '.CLAUDE.md-' + crypto.randomBytes(12).toString('hex') + '.tmp');
      fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (!current(identity)) return false;
      fs.renameSync(tmp, file);
      return true;
    } catch { return false; }
    finally { if (tmp) { try { fs.unlinkSync(tmp); } catch {} } }
  }
  function accountMemoryPath(identity, name) {
    if (typeof name !== 'string') return null;
    const safePath = path.basename(name);
    if (!safePath.endsWith('.md') || safePath.toLowerCase() === 'memory.md') return null;
    const dir = path.join(accountRoot(identity.accountId, identity.orgId), 'memory', 'memory');
    return { dir, safePath, file: path.join(dir, safePath) };
  }
  function readAccountFile(file, safePath) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ACCOUNT_MAX_BYTES) return null;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const actual = fs.fstatSync(fd);
        if (!actual.isFile() || actual.size > ACCOUNT_MAX_BYTES) return null;
        const data = fs.readFileSync(fd);
        if (data.length > ACCOUNT_MAX_BYTES) return null;
        return { path: safePath, content: data.toString('utf8'), updatedAt: actual.mtime.toISOString() };
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  }
  async function listAccountMemories(includeContent = true) {
    const identity = await context();
    if (!identity || !current(identity)) return [];
    try {
      const dir = path.join(accountRoot(identity.accountId, identity.orgId), 'memory', 'memory');
      checkDirectoryChain(dir, false);
      const results = [];
      for (const name of fs.readdirSync(dir)) {
        const target = accountMemoryPath(identity, name);
        if (!target) continue;
        if (includeContent) {
          const item = readAccountFile(target.file, target.safePath);
          if (item) results.push(item);
        } else {
          try {
            const stat = fs.lstatSync(target.file);
            if (stat.isFile() && !stat.isSymbolicLink()) results.push({ path: name, updatedAt: stat.mtime.toISOString() });
          } catch {}
        }
      }
      return current(identity) ? results.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')) : [];
    } catch { return []; }
  }
  async function readAccountMemory(name) {
    const identity = await context();
    if (!identity || !current(identity)) return null;
    const target = accountMemoryPath(identity, name);
    if (!target) return null;
    try { checkDirectoryChain(target.dir, false); const item = readAccountFile(target.file, target.safePath); return current(identity) ? item : null; }
    catch { return null; }
  }
  async function writeAccountMemory(name, content) {
    const identity = await context();
    if (!identity || !current(identity) || typeof content !== 'string') return false;
    const target = accountMemoryPath(identity, name);
    if (!target) return false;
    let tmp;
    try {
      checkDirectoryChain(target.dir, false);
      const stat = fs.lstatSync(target.file);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      tmp = path.join(target.dir, '.memory-' + crypto.randomBytes(12).toString('hex') + '.tmp');
      fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (!current(identity)) return false;
      fs.renameSync(tmp, target.file);
      return true;
    } catch { return false; }
    finally { if (tmp) { try { fs.unlinkSync(tmp); } catch {} } }
  }
  async function deleteAccountMemory(name) {
    const identity = await context();
    if (!identity || !current(identity)) return false;
    const target = accountMemoryPath(identity, name);
    if (!target) return false;
    try {
      checkDirectoryChain(target.dir, false);
      const stat = fs.lstatSync(target.file);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (!current(identity)) return false;
      fs.unlinkSync(target.file);
      return true;
    } catch { return false; }
  }
  async function resetMemories() {
    const identity = await context();
    if (!identity || !current(identity)) return false;
    try {
      const base = accountRoot(identity.accountId, identity.orgId);
      const targets = [path.join(base, 'memory', 'memory')];
      const spaces = path.join(base, 'spaces');
      function inspectTree(dir) {
        const stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Invalid memory directory');
        for (const name of fs.readdirSync(dir)) {
          const child = path.join(dir, name), item = fs.lstatSync(child);
          if (item.isSymbolicLink()) throw new Error('Linked memory entry');
          if (item.isDirectory()) inspectTree(child);
          else if (!item.isFile()) throw new Error('Invalid memory entry');
        }
      }
      try {
        checkDirectoryChain(spaces, false);
        for (const name of fs.readdirSync(spaces)) {
          const space = path.join(spaces, name), stat = fs.lstatSync(space);
          if (stat.isSymbolicLink()) throw new Error('Linked space');
          if (stat.isDirectory()) targets.push(path.join(space, 'memory'));
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const dir of targets) {
        try { checkDirectoryChain(dir, false); inspectTree(dir); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const dir of targets) {
        if (!current(identity)) return false;
        try {
          checkDirectoryChain(dir, false);
          inspectTree(dir);
          if (!current(identity)) return false;
          fs.rmSync(dir, { recursive: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!current(identity)) return false;
        checkDirectoryChain(dir, true);
      }
      return current(identity);
    } catch { return false; }
  }
  return { readGlobalMemory, writeGlobalMemory, listAccountMemories, readAccountMemory, writeAccountMemory, deleteAccountMemory, resetMemories };
}
module.exports = { createCoworkGlobalMemory, MAX_BYTES, ACCOUNT_MAX_BYTES };
