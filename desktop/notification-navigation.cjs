'use strict';

function createNotificationNavigation({ getWindow, getWebContents, dispatch }) {
  return function focusAppAndNavigate(route) {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (!window.isVisible()) window.show();
    window.focus();
    if (!route) return;
    const webContents = getWebContents();
    if (webContents && !webContents.isDestroyed()) dispatch(webContents, route);
  };
}

module.exports = { createNotificationNavigation };
