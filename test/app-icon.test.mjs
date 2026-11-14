import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { APP_ICON_PATH, WINDOWS_AUMID } = createRequire(import.meta.url)('../desktop/app-icon.cjs');

test('native window identity matches installer shortcut identity and icon', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../electron-builder.json', import.meta.url), 'utf8'));
  assert.equal(WINDOWS_AUMID, config.appId);
  assert.equal(config.win.icon, 'desktop/assets/clawd.ico');
  assert.equal(config.win.signAndEditExecutable, true);
  const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /\{ APP_ICON_PATH, WINDOWS_AUMID \} = require\('\.\/app-icon\.cjs'\)/);
  assert.match(main, /app\.setAppUserModelId\(WINDOWS_AUMID\)/);
  assert.match(main, /icon: APP_ICON_PATH/);
  assert.doesNotMatch(main, /CodeDesktop\.Reconstruction/);
});

test('native app icon is vendored and contains valid Windows icon frames', () => {
  assert.equal(APP_ICON_PATH, fileURLToPath(new URL('../desktop/assets/clawd.ico', import.meta.url)));
  const bytes = fs.readFileSync(APP_ICON_PATH);
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  assert.ok(count > 0);
  const sizes = [];
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    sizes.push(bytes[entry] || 256);
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    assert.ok(length > 0);
    assert.ok(offset >= 6 + count * 16);
    assert.ok(offset + length <= bytes.length);
  }
  assert.ok(sizes.includes(256), 'high-DPI taskbar/executable frame must exist');
  assert.ok(sizes.includes(32), 'standard Windows taskbar frame must exist');
});
