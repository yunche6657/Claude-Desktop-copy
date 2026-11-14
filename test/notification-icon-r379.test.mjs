import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createNotificationIconLoader } = require('../desktop/notification-icon.cjs');
const { SHIP } = require('../build/packaging.cjs');
const { createAsar, readAsar } = require('../build/asar.cjs');
const source = readFileSync(new URL('../resources/ion-dist/favicon.ico', import.meta.url));
const offset = source.readUInt32LE(18);
const size = source.readUInt32LE(14);
const image = readFileSync(new URL('../desktop/assets/notification-icon.png', import.meta.url));

test('portable notification asset is the 48px PNG embedded in the captured favicon', () => {
  assert.equal(source[6], 48);
  assert.deepEqual(image, source.subarray(offset, offset + size));
  assert.deepEqual(image.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.ok(SHIP.includes('desktop'));
});

test('loader uses its relocated packaged asset and returns nativeImage result', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notification-icon-'));
  try {
    mkdirSync(path.join(dir, 'assets'));
    copyFileSync(new URL('../desktop/notification-icon.cjs', import.meta.url), path.join(dir, 'notification-icon.cjs'));
    copyFileSync(new URL('../desktop/assets/notification-icon.png', import.meta.url), path.join(dir, 'assets', 'notification-icon.png'));
    const { createNotificationIconLoader: relocated } = require(path.join(dir, 'notification-icon.cjs'));
    const marker = { isEmpty: () => false };
    let bytes;
    const load = relocated({ createFromBuffer: buffer => { bytes = buffer; return marker; } });
    assert.equal(load(), marker);
    assert.deepEqual(bytes, image);
    assert.equal(typeof createNotificationIconLoader, 'function');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the app archive preserves the loader and its asset at matching relative paths', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notification-asar-'));
  try {
    const archive = path.join(dir, 'app.asar');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = ['desktop/notification-icon.cjs', 'desktop/assets/notification-icon.png'];
    createAsar(root, files, { outFile: archive });
    const packed = readAsar(archive).files;
    assert.deepEqual(packed.get(files[1]), image);
    assert.deepEqual(packed.get(files[0]), readFileSync(path.join(root, files[0])));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
