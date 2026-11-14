'use strict';

// Names and comparisons below are from the shipped HXe/TJ/_ri/HJ and kA.
const BUILTIN_NAMES = Object.freeze(['claude-in-chrome','office','computer-use','workspace','mcp-registry','plugins','skills','cowork-onboarding','dev-debug',
  'Claude Preview','Claude Browser','Framebuffer','visualize','Window Halo','ccd_session','ccd_directory','ccd_session_mgmt','ccd_connectors',
  'ccd_host','ccd_pr','ccd_sidebar','ccd_turn','ccd_window','ccd_view','ccd_settings','terminal','Claude Code iOS Simulator',
  'Claude Code Android Emulator','remote-devices','scheduled-tasks','cowork','session_info','dispatch','memory']);
const PREFIX_NAMES = Object.freeze([...BUILTIN_NAMES.filter(name => !['memory','terminal','workspace','office','visualize'].includes(name)), 'Claude_for_Chrome']);
const clean = value => value.replace(/[^a-zA-Z0-9_-]/g, '_');
const key = value => clean(value).toLowerCase().replace(/[-_]+/g, '_');
function parts(value) {
  const normal = clean(value);
  return { keys: [...new Set([key(value), key(value.replace(/^plugin:/, ''))])],
    read: [`${value}:`,`mcp__local_${normal}__`,`mcp__internal_${normal}__`,`mcp__${normal}__`,`mcp__remote-devices__${normal}__`]
      .map(name => name.toLowerCase().replace(/-/g, '_')).filter(name => name !== 'mcp__remote_devices__') };
}
function overlaps(a, b) {
  return a.keys.some(value => b.keys.includes(value)) || a.read.some(value => b.read.some(other => value.startsWith(other) || other.startsWith(value)));
}
const broadParts = BUILTIN_NAMES.map(parts);
const prefixParts = PREFIX_NAMES.map(name => { const p = parts(name); return { ...p, read: p.read.map(value => value.replace(/(__|:)$/, '')) }; });
function isReservedCliMcpName(name) {
  if (typeof name !== 'string') throw new TypeError('server name must be a string');
  const normalized = name.replace(/^plugin:/, '');
  const valid = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
  if (!valid.test(name) || !valid.test(normalized) || /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(name) ||
      parts(name).keys.some(value => !/[a-z0-9]/.test(value))) return true;
  const prefixKey = name.replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase().replace(/-/g, '_');
  if (PREFIX_NAMES.some(value => prefixKey.startsWith(value.replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase().replace(/-/g, '_')))) return true;
  const candidate = parts(name);
  return prefixParts.some(item => overlaps(candidate, item)) || broadParts.some(item => overlaps(candidate, item));
}
function createReservedSource() {
  const record = Object.freeze({ complete: true, names: BUILTIN_NAMES, isReserved: isReservedCliMcpName });
  return { read: async () => record, isCurrent: value => value === record, subscribe: () => () => {} };
}

// The runtime is attached after the bridge constructs its kernel. Use .on,
// not feature.value: the original ey('513873720') reads the gate's .on.
function createCliMcpGateSource() {
  let runtime = null, value, revision = 0, disposers = [], invalidated = false;
  const listeners = new Set();
  const changed = () => { revision++; for (const fn of [...listeners]) { try { fn(); } catch {} } };
  function detach() { for (const dispose of disposers.splice(0)) dispose(); runtime = null; value = undefined; invalidated = false; changed(); }
  function attach(next) {
    detach();
    runtime = next;
    if (!next) return;
    const observe = item => { value = item; changed(); };
    disposers.push(next.onFeatureChange('513873720', observe));
    disposers.push(next.observeFeatureGate('513873720', observe));
    if (typeof next.onSecurityFreshnessChange === 'function') disposers.push(next.onSecurityFreshnessChange(fresh => { if (fresh) invalidated = false; changed(); }));
    changed();
  }
  function state() {
    try {
      if (!runtime) return { complete: false };
      // Synchronize the runtime's current account/source before accepting its
      // cached gate; .value is deliberately ignored for this boolean gate.
      runtime.getFeatureValue('513873720', undefined);
      if (invalidated || typeof runtime.isSecurityFreshForCurrentSource !== 'function' || !runtime.areFeaturesLoaded() || !runtime.isSecurityFreshForCurrentSource()) return { complete: false };
      return { complete: true, featureEnabled: value?.on === true };
    } catch { return { complete: false }; }
  }
  return {
    attach, invalidate: () => { invalidated = true; changed(); }, dispose: detach,
    read: async () => ({ ...state(), revision }),
    isCurrent: item => item?.revision === revision && state().complete && state().featureEnabled === item.featureEnabled,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
module.exports = { createReservedSource, isReservedCliMcpName, createCliMcpGateSource, BUILTIN_NAMES, PREFIX_NAMES };
