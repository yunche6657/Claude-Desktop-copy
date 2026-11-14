'use strict';

// Rules extracted from the 3p main-process bundle; web rules contribute only
// their explicitly declared remote.fetchedAs keys to the main allowlist.
const { main, web } = require('./shim/growthbook-main-3p.json');

function hardcodedMainGrowthBookFeatures({ builtinBrowserEnabled = false, selfHostedSessions = false } = {}) {
  const result = {};
  for (const [key, rule] of Object.entries(main)) {
    if (rule.rule !== 'forced' && !(rule.rule === 'forcedFor' &&
      ((rule.group === 'builtinBrowser' && builtinBrowserEnabled) ||
       (rule.group === 'sessionHostDevice' && selfHostedSessions)))) continue;
    const value = structuredClone(rule.value);
    result[key] = { value, on: !!value, off: !value, source: 'force', experiment: null, experimentResult: null };
  }
  return result;
}

function growthBookRemoteAllowedKeys() {
  return new Set([
    ...Object.keys(main).filter(key => main[key]?.rule === 'remote'),
    ...Object.values(web).filter(rule => rule.rule !== 'computed' && typeof rule.remote === 'object' && rule.remote !== null).map(rule => rule.remote.fetchedAs),
  ]);
}

// Mirrors Kzt: only permitted remote entries survive, and forced values win.
function mergeRemoteFeatures(remote, options) {
  const allowed = {};
  for (const key of growthBookRemoteAllowedKeys()) if (key in remote) allowed[key] = remote[key];
  return { ...allowed, ...hardcodedMainGrowthBookFeatures(options) };
}

module.exports = { hardcodedMainGrowthBookFeatures, growthBookRemoteAllowedKeys, mergeRemoteFeatures };
