import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createCoworkMemoryIdentityResolver} = require('../desktop/cowork-memory-identity.cjs');
const {createCoworkGlobalMemory} = require('../desktop/cowork-global-memory.cjs');

test('mode change while awaiting identity prevents writing the old account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-mode-'));
  try {
    let mode = '1p';
    const resolve = createCoworkMemoryIdentityResolver({getMode: () => mode, get3pIdentity: () => null});
    const account = () => ({accountId: 'account', orgId: 'org', isCurrent: () => true});
    const memory = createCoworkGlobalMemory({userDataDir: dir, getAccountContext: () => resolve(account)});
    const pending = memory.writeGlobalMemory('fixture');
    mode = '3p';
    resolve.observe();
    assert.equal(await pending, false);
    assert.equal(fs.existsSync(path.join(dir, 'local-agent-mode-sessions', 'account')), false);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('observed ABA invalidates old snapshot; a fresh 1p snapshot is usable', () => {
  let mode = '1p', accountValid = true;
  const three = {accountId: 'install', orgId: 'org'};
  const resolve = createCoworkMemoryIdentityResolver({getMode: () => mode, get3pIdentity: () => three});
  const account = () => ({accountId: 'account', orgId: 'org', isCurrent: () => accountValid});
  const old = resolve(account);
  mode = '3p'; resolve.observe();
  assert.equal(resolve(account), three);
  mode = '1p'; resolve.observe();
  assert.equal(old.isCurrent(), false);
  const fresh = resolve(account);
  assert.equal(fresh.isCurrent(), true);
  accountValid = false;
  assert.equal(fresh.isCurrent(), false);
  accountValid = true;
  assert.equal(fresh.isCurrent(), false);
  assert.equal(resolve(() => ({accountId: 'account', orgId: 'org'})), null);
});

test('mode read errors and async values fail closed', () => {
  let mode = '1p';
  const resolve = createCoworkMemoryIdentityResolver({getMode: () => mode, get3pIdentity: () => null});
  const account = () => ({accountId: 'account', orgId: 'org', isCurrent: () => true});
  const old = resolve(account);
  mode = Promise.reject(Error('unavailable'));
  assert.equal(old.isCurrent(), false);
  mode = '1p';
  assert.equal(old.isCurrent(), false);
});
