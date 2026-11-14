import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createNotificationNavigation } = require('../desktop/notification-navigation.cjs');

test('focus and navigation match the fixed upstream method', () => {
  const source = readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js', import.meta.url), 'utf8');
  const start = source.indexOf('focusAppAndNavigate(e){');
  const end = source.indexOf('isUserViewingSession(', start);
  assert.ok(start >= 0 && end > start);
  const method = source.slice(start, end);
  const scenarios = [
    { window: false, view: true, route: '/target' },
    { destroyed: true, view: true, route: '/target' },
    { visible: false, view: true, route: '/target' },
    { visible: true, view: true, route: '/target' },
    { visible: false, view: false, route: '/target' },
    { visible: true, view: true, viewDestroyed: true, route: '/target' },
    { visible: false, view: true, route: '' },
    { visible: false, view: true, route: undefined },
    { visible: true, view: true, route: '/target', noDispatcher: true },
  ];
  for (const scenario of scenarios) {
    function harness(original) {
      const calls = [];
      const window = scenario.window === false ? null : {
        isDestroyed: () => !!scenario.destroyed,
        isVisible: () => !!scenario.visible,
        show: () => calls.push('show'),
        focus: () => calls.push('focus'),
      };
      const webContents = scenario.view ? { isDestroyed: () => !!scenario.viewDestroyed } : null;
      const dispatcher = scenario.noDispatcher ? undefined : { dispatchNavigate: route => calls.push(['navigate', route]) };
      if (original) {
        const upstream = vm.runInNewContext(`({${method}}).focusAppAndNavigate`, {
          N: { info() {} }, nv: { getDispatcher: contents => { assert.equal(contents, webContents); return dispatcher; } },
        });
        upstream.call({ mainWindow: window, mainView: webContents ? { webContents } : null }, scenario.route);
      } else {
        createNotificationNavigation({
          getWindow: () => window,
          getWebContents: () => webContents,
          dispatch: (contents, route) => { assert.equal(contents, webContents); dispatcher?.dispatchNavigate(route); },
        })(scenario.route);
      }
      return calls;
    }
    assert.deepEqual(harness(false), harness(true), JSON.stringify(scenario));
  }
});
