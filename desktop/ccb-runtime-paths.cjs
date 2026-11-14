'use strict';
const path = require('node:path');

// Executables and Bun's module tree must remain outside app.asar. Source
// launches retain their repository-local pinned runtime.
function resolveAgentRoot({ appRoot = path.resolve(__dirname, '..'), resourcesPath = process.resourcesPath } = {}) {
  if (resourcesPath && (appRoot.endsWith('.asar') || path.resolve(appRoot) === path.join(path.resolve(resourcesPath), 'app'))) {
    return resourcesPath;
  }
  return appRoot;
}

module.exports = { resolveAgentRoot };
