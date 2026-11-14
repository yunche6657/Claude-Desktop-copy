'use strict';
const fs = require('node:fs');
const path = require('node:path');
const KEY = 'custom3pBootstrapOidc';
class HybridEncryptionUnavailableError extends Error {
  constructor() { super('hybrid slot encryption unavailable'); this.name = 'HybridEncryptionUnavailableError'; this.code = 'HYBRID_ENCRYPTION_UNAVAILABLE'; }
}

// Aw/Uw/Ww use a separate named Electron store and safeStorage per slot.
// Encryption unavailable leaves this session usable in memory and refuses disk writes.
function createHybridOidcStore({ userData, safeStorage }) {
  const file = path.join(userData, 'custom3p-bootstrap-oidc.json');
  const memory = new Map();
  const ownership = new Map();
  function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  function read(key) {
    if (memory.has(key)) return memory.get(key);
    const encoded = load()?.[KEY]?.[key];
    if (!encoded || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64')));
      memory.set(key, value); return value;
    } catch { return undefined; }
  }
  function write(key, value, { isCurrent = () => true } = {}) {
    let cancelled = false;
    const check = () => { if (!isCurrent()) { cancelled = true; const error = new Error('OAuth context changed'); error.slotUnchanged = true; throw error; } };
    check();
    const owner = Symbol('hybrid-write');
    const hadMemory = memory.has(key), oldMemory = memory.get(key), oldOwner = ownership.get(key);
    let tmp, oldEncoded, hadDisk = false, committedEncoded;
    function retainMemory() { memory.set(key, value); ownership.set(key, owner); }
    function receipt() {
      return { rollbackIfCurrent() {
        if (ownership.get(key) !== owner || memory.get(key) !== value) return false;
        if (committedEncoded !== undefined) {
          const current = load();
          if (current?.[KEY]?.[key] !== committedEncoded) {
            // Another instance replaced this disk slot: discard only our stale
            // cached value and let the next read load the newer disk value.
            memory.delete(key); ownership.delete(key); return true;
          }
          const slots = { ...current[KEY] };
          if (hadDisk) slots[key] = oldEncoded; else delete slots[key];
          current[KEY] = slots;
          const rollbackTmp = `${file}.rollback-${process.pid}`;
          try {
            fs.writeFileSync(rollbackTmp, JSON.stringify(current, null, 2), { mode: 0o600 });
            fs.renameSync(rollbackTmp, file);
          } catch (error) { try { fs.unlinkSync(rollbackTmp); } catch {} throw error; }
        }
        if (hadMemory) memory.set(key, oldMemory); else memory.delete(key);
        if (oldOwner !== undefined) ownership.set(key, oldOwner); else ownership.delete(key);
        return true;
      } };
    }
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new HybridEncryptionUnavailableError();
      }
      const data = load();
      hadDisk = Object.hasOwn(data[KEY] ?? {}, key); oldEncoded = data[KEY]?.[key];
      const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
      check();
      data[KEY] = { ...data[KEY], [key]: encrypted };
      fs.mkdirSync(userData, { recursive: true });
      tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      check();
      fs.renameSync(tmp, file);
      tmp = undefined; committedEncoded = encrypted;
      retainMemory();
      return receipt();
    } catch (error) {
      if (tmp !== undefined) { try { fs.unlinkSync(tmp); } catch {} }
      if (!cancelled && isCurrent()) {
        retainMemory();
        error.credentialRetained = true; error.memoryOnly = true; error.receipt = receipt();
      }
      throw error;
    }
  }

  function remove(key, {isCurrent = () => true} = {}) {
    if (!isCurrent()) return false;
    // Native Ytn drops the in-memory slot before mutating its store.
    memory.delete(key); ownership.delete(key);
    const data = load();
    if (!data?.[KEY] || !Object.hasOwn(data[KEY], key)) return false;
    const slots = { ...data[KEY] }; delete slots[key]; data[KEY] = slots;
    const tmp = `${file}.delete-${process.pid}`;
    try {
      fs.mkdirSync(userData, {recursive:true});
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {mode:0o600});
      if (!isCurrent()) { fs.unlinkSync(tmp); return false; }
      fs.renameSync(tmp, file);
      memory.delete(key); ownership.delete(key);
      return true;
    } catch(error) { try { fs.unlinkSync(tmp); } catch {} throw error; }
  }
  return { read, write, delete: remove, clearMemory: () => { memory.clear(); ownership.clear(); } };
}
module.exports = { createHybridOidcStore, HybridEncryptionUnavailableError };
