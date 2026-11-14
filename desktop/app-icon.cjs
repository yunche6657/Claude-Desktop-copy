'use strict';

const path = require('node:path');

// Keep native window/tray identity independent of ion-dist. Packaging uses
// this same multi-resolution ICO for the executable and shortcuts.
const APP_ICON_PATH = path.join(__dirname, 'assets', 'clawd.ico');

// Must match electron-builder.json appId so NSIS shortcuts and live windows group together.
const WINDOWS_AUMID = 'dev.reconstruction.code-desktop';

module.exports = { APP_ICON_PATH, WINDOWS_AUMID };
