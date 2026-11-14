'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Electron keys its native singleton by userData. Keep that key independent of
// the install directory and the workspace used later for Chromium storage.
function resolveInstanceDirectory({ app, env = process.env, cwd = process.cwd() }) {
  if (env.CLAUDE_INSTANCE_PROFILE) return path.resolve(env.CLAUDE_INSTANCE_PROFILE);
  if (env.CLAUDE_BACKGROUND_CHECK === '1') {
    return path.resolve(env.CLAUDE_WORKSPACE || cwd, '.data', 'single-instance');
  }
  return path.join(app.getPath('appData'), 'CodeDesktop.Reconstruction', 'SingleInstance');
}

function acquireSingleInstance({ app, getWindow, env = process.env, cwd = process.cwd(), mkdir = fs.mkdirSync }) {
  let pending = false;
  function activate() {
    const win = getWindow();
    if (!win || win.isDestroyed()) { pending = true; return false; }
    pending = false;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  }
  const onSecondInstance = () => activate();
  app.on('second-instance', onSecondInstance);
  const previous = app.getPath('userData');
  const directory = resolveInstanceDirectory({ app, env, cwd });
  let primary;
  try {
    mkdir(directory, { recursive: true });
    app.setPath('userData', directory);
    primary = app.requestSingleInstanceLock();
  } catch (error) {
    app.removeListener('second-instance', onSecondInstance);
    throw error;
  } finally {
    app.setPath('userData', previous);
  }
  if (!primary) {
    app.removeListener('second-instance', onSecondInstance);
    // No cleanup hooks/services have been installed yet.
    app.quit();
  }
  return {
    primary, directory, activate,
    windowReady() { if (pending) activate(); },
    // Do not release the lock in before-quit: cleanup may defer quitting and a
    // second process must not start alongside it. Electron releases it on exit,
    // including app.relaunch(), which starts its replacement after exit.
  };
}

module.exports = { acquireSingleInstance, resolveInstanceDirectory };
