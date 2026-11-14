'use strict';

// Input coercion from the shipped managed-config parser. Field schemas,
// diagnostics and fail-closed policy remain the caller's responsibility.
function coerceManagedBoolean(value) {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 || (value !== 0 && undefined);
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\r/g, '').toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}
function parseManagedJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch {
    try { return JSON.parse(value.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')); }
    catch { return value; }
  }
}
function coerceManagedInput(schemaType, value) {
  if (schemaType === 'boolean') return coerceManagedBoolean(value);
  if (schemaType === 'string' || schemaType === 'enum') return value;
  return parseManagedJson(value);
}
module.exports = { coerceManagedBoolean, parseManagedJson, coerceManagedInput };
