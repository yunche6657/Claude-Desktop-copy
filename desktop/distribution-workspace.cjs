'use strict';
const path = require('node:path');
const fs = require('node:fs');
// Installed applications must never depend on the launcher's current directory.
function prepareDistributionWorkspace({app, env=process.env, mkdir=dir=>fs.mkdirSync(dir,{recursive:true})}={}) {
  if (!app?.isPackaged) return env.CLAUDE_WORKSPACE || null;
  const base=env.LOCALAPPDATA || app.getPath('appData');
  const workspace=env.CLAUDE_WORKSPACE || path.join(base,'CodeDesktop-Reconstruction','workspace');
  mkdir(workspace);
  const configDir=path.join(base,'CodeDesktop-Reconstruction','configLibrary');
  mkdir(configDir);
  if (!env.CLAUDE_RECONSTRUCTION_CONFIG_DIR) env.CLAUDE_RECONSTRUCTION_CONFIG_DIR=configDir;
  env.CLAUDE_WORKSPACE=workspace;
  return workspace;
}
module.exports={prepareDistributionWorkspace};
