'use strict';

const fs = require('node:fs');

// One cache per host, initialized once even if the first read fails.
function createDeploymentMode({ getConfigPath, resetWindowBounds, log } = {}) {
  let initialized = false;
  let cached;
  let appConfigInitialized = false;
  let appConfigMode;
  const valid = value => value === '1p' || value === '3p';
  function get() {
    if (!initialized) {
      initialized = true;
      try {
        const value = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')).deploymentMode;
        cached = valid(value) ? value : undefined;
      } catch { cached = undefined; }
    }
    return cached;
  }
  // The app-config cache and the persisted-mode cache have independent first reads.
  // This models the mode field only, not the original's complete config schema.
  function getAppConfigMode() {
    if (!appConfigInitialized) {
      appConfigInitialized = true;
      try {
        const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
        appConfigMode = config && !Array.isArray(config) && valid(config.deploymentMode)
          ? config.deploymentMode : undefined;
      } catch { appConfigMode = undefined; }
    }
    return appConfigMode;
  }
  async function set(value, { skipWindowBoundsReset = false } = {}) {
    if (!valid(value)) throw new TypeError('invalid deployment mode');
    const previous = get();
    const file = getConfigPath();
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...config, deploymentMode: value }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally {
      // Failed writes or renames must not leave a copied config behind.
      try { fs.unlinkSync(tmp); } catch { /* absent after a successful rename */ }
    }
    cached = value;
    if (appConfigInitialized && config.deploymentMode !== value) appConfigMode = value;
    if (previous !== value && !skipWindowBoundsReset && typeof resetWindowBounds === 'function') {
      try { await resetWindowBounds(); }
      catch (error) {
        try { log?.(`deployment mode window bounds reset failed: ${String(error?.message || error)}`); } catch {}
      }
    }
  }
  return { get, getAppConfigMode, set };
}

module.exports = { createDeploymentMode };
