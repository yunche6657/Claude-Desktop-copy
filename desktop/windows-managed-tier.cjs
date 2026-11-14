'use strict';

// Windows managed-tier selection; caller supplies the actual registry adapter,
// schema parser and diagnostic callbacks. No process or registry access occurs here.
// Keep one instance across configuration rebuilds: machineSeen is a process latch.
// The returned unknownValuesUnusable is only DUe's unknown-name signal; the host
// must also consider managed diagnostics and valid keys before resolving the tier.
function createWindowsManagedTier({ reader, keyPath, valueNames, ignoredNames, canonicalNames, flatToConfigKey, parse, classifyUnknown, formatUnknown, onWarning, onError, onUnreadable } = {}) {
  if (typeof keyPath !== 'string' || !Array.isArray(valueNames) || !(ignoredNames instanceof Set) || !(canonicalNames instanceof Map) || !(flatToConfigKey instanceof Map) || typeof parse !== 'function' || typeof classifyUnknown !== 'function' || typeof formatUnknown !== 'function' || typeof onWarning !== 'function' || typeof onError !== 'function' || typeof onUnreadable !== 'function') throw new TypeError('managed tier dependencies required');
  let machineSeen = false;
  function read() {
    if (!reader) { onError('Native managed-config reader unavailable; managed tier cannot be read'); return { values: {}, machineScoped: false, unknownValuesUnusable: false, readerAvailable: false }; }
    const requests = [];
    for (const hive of ['HKCU', 'HKLM']) for (const valueName of valueNames) requests.push({ hive, keyPath, valueName });
    const results = reader.readRegistryValues(requests) ?? [];
    const byKey = new Map();
    for (const item of results) byKey.set(item.key, item.value ?? null);
    const readHive = (hive, failed = []) => {
      const prefix = `${hive}\\${keyPath}`;
      const raw = {};
      for (const name of valueNames) { const value = byKey.get(`${prefix}\\${name}`) ?? null; if (value !== null) raw[name] = value; }
      return parse(raw, failed);
    };
    const prefix = `HKLM\\${keyPath}\\`;
    const entries = reader.enumRegistryValues?.('HKLM', keyPath) ?? [];
    if (results.some(item => item.key.startsWith(prefix) && item.value != null) || entries.length > 0 || machineSeen) {
      machineSeen = true;
      let recognized = false;
      const unknown = [], failed = [];
      for (const {name} of entries) {
        if (ignoredNames.has(name)) continue;
        const warning = classifyUnknown(`HKLM\\${keyPath}`, name);
        if (warning !== undefined) { onWarning(warning); continue; }
        const canonical = canonicalNames.get(name.toLowerCase());
        if (canonical !== undefined) {
          recognized = true;
          if (byKey.get(`${prefix}${canonical}`) == null) {
            const key = flatToConfigKey.get(canonical);
            if (key !== undefined) { onUnreadable(key); failed.push(key); }
            onError(`Failed to read "HKLM\\${keyPath}\\${canonical}": could not decode value (unsupported registry type?)`, key);
          }
        } else unknown.push(name);
      }
      for (const name of unknown) onWarning(`Ignoring HKLM\\${keyPath} value: ${formatUnknown(name)}`);
      const unusable = unknown.length > 0 && !recognized;
      if (unusable) onError(`HKLM\\${keyPath} contains no value names the managed tier can honor; managed configuration is unusable and local settings are disabled`);
      return { values: readHive('HKLM', failed), machineScoped: true, unknownValuesUnusable: unusable, readerAvailable: true };
    }
    return { values: readHive('HKCU'), machineScoped: false, unknownValuesUnusable: false, readerAvailable: true };
  }
  return { read };
}
module.exports = { createWindowsManagedTier };
