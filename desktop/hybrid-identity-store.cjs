'use strict';
const fs = require('node:fs');
const path = require('node:path');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Native G5t/K5t/q5t: identities live alongside existing deployment settings.
function createHybridIdentityStore({ file }) {
  const load = () => {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  };
  const read = key => {
    const entry = load().hybridIdentity?.[key];
    if (!entry || typeof entry !== 'object' || !UUID.test(entry.accountUuid)) return undefined;
    return { accountUuid: entry.accountUuid.toLowerCase(), accountTaggedId: typeof entry.accountTaggedId === 'string' && entry.accountTaggedId ? entry.accountTaggedId : undefined };
  };
  const record = (key, value, {isCurrent = () => true} = {}) => {
    if (!UUID.test(value?.accountUuid)) throw new TypeError('invalid account UUID');
    if (!isCurrent()) return undefined;
    const data = load(), map = data.hybridIdentity && typeof data.hybridIdentity === 'object' && !Array.isArray(data.hybridIdentity) ? data.hybridIdentity : {};
    const previous = map[key], next = {accountUuid:value.accountUuid.toLowerCase(), accountTaggedId:value.accountTaggedId};
    if (previous && typeof previous.accountUuid === 'string' && previous.accountUuid.toLowerCase() === next.accountUuid && (next.accountTaggedId === undefined || previous.accountTaggedId === next.accountTaggedId)) return false;
    data.hybridIdentity = {...map, [key]:next};
    fs.mkdirSync(path.dirname(file), {recursive:true});
    const tmp = `${file}.identity-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {mode:0o600});
      if (!isCurrent()) return undefined;
      fs.renameSync(tmp,file); return true;
    } finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  };
  return {read, record};
}
module.exports = {createHybridIdentityStore};
