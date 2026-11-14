'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The original attempts resources/icon.png. That file is absent from the captured
// Windows resources; this PNG is the 48px image from the shipped frontend favicon.
// Keeping it beside this module lets it travel inside both app and app.asar.
function createNotificationIconLoader(nativeImage) {
  const iconPath = path.join(__dirname, 'assets', 'notification-icon.png');
  return () => nativeImage.createFromBuffer(fs.readFileSync(iconPath));
}

module.exports = { createNotificationIconLoader };
