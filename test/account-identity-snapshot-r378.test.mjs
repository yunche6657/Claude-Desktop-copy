import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { createAccountStore } = createRequire(import.meta.url)('../desktop/account-store.cjs');
const temp = 'D:/CodexArtifacts/claude-code-desktop/tmp';
function fixture() {
  fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, 'identity-snapshot-'));
  const filePath = path.join(root, 'accounts.json');
  const store = createAccountStore({ filePath });
  return { root, filePath, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function tokens(account, org) {
  return { account: { uuid: account }, organization: { uuid: org }, accessToken: 'fixture-secret', refreshToken: 'fixture-refresh' };
}

test('snapshots bind account and organization revisions across ABA changes', () => {
  const f = fixture();
  try {
    const a = f.store.upsertFromTokens(tokens('a', 'o1'));
    f.store.upsertFromTokens(tokens('a', 'o2'));
    assert.equal(f.store.setActiveOrganization('a', 'o1'), true);
    const snap = f.store.getActiveIdentitySnapshot();
    assert.deepEqual(Object.keys(snap).sort(), ['accountId', 'isCurrent', 'orgId']);
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), { accountId:'a', orgId:'o1' });
    assert.equal(snap.isCurrent(), true);
    assert.equal(f.store.setActiveOrganization('a', 'o2'), true);
    assert.equal(f.store.setActiveOrganization('a', 'o1'), true);
    assert.equal(snap.isCurrent(), false);
    assert.equal(f.store.getActiveIdentitySnapshot().isCurrent(), true);
    const beforeSwitch = f.store.getActiveIdentitySnapshot();
    const b = f.store.upsertFromTokens(tokens('b', 'ob'));
    assert.equal(f.store.setActive(a.id), true);
    assert.equal(beforeSwitch.isCurrent(), false);
    assert.equal(f.store.getActiveIdentitySnapshot().isCurrent(), true);
    const beforeRemove = f.store.getActiveIdentitySnapshot();
    assert.equal(f.store.remove(a.id), true);
    assert.equal(f.store.list()[0].id, b.id);
    f.store.upsertFromTokens(tokens('a', 'o1'));
    assert.equal(beforeRemove.isCurrent(), false);
    assert.equal(f.store.getActiveIdentitySnapshot().isCurrent(), true);
    assert.deepEqual(f.store.getActiveIdentity(), {accountId:'a', orgId:'o1'});
  } finally { f.cleanup(); }
});

test('legacy null revision is invalidated by first save and observed invalidity is permanent', () => {
  const f = fixture();
  try {
    assert.equal(f.store.getActiveIdentitySnapshot(), null);
    const legacy = { version: 1, activeId: 'legacy', accounts: [{id:'legacy', accountUuid:'a', organizationUuid:'o', accessToken:'fixture-secret'}] };
    fs.writeFileSync(f.filePath, JSON.stringify(legacy));
    const snapshot = f.store.getActiveIdentitySnapshot();
    assert.equal(snapshot.isCurrent(), true);
    assert.equal(f.store.setActive('legacy'), true);
    assert.equal(snapshot.isCurrent(), false);
    assert.equal(f.store.getActiveIdentitySnapshot().isCurrent(), true);
    fs.writeFileSync(f.filePath, JSON.stringify(legacy));
    assert.equal(snapshot.isCurrent(), false);
    fs.unlinkSync(f.filePath);
    assert.equal(f.store.getActiveIdentitySnapshot(), null);
  } finally { f.cleanup(); }
});
