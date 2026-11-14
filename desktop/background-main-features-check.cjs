'use strict';
const assert = require('node:assert/strict');
async function runMainFeaturesCheck({ report, ev, getMainFeatureProof, settleMainFeatures, proveHybridSlotStorage }) {
  const call = (method, args = []) => ev(`window['claude.settings'].Custom3pSetup[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const list = await call('listConfigs');
  const id = list.appliedId;
  assert.equal(typeof id, 'string');
  const initial = await call('readConfig', [id]);
  assert.equal(initial.ok, true);
  const observations = [];
  const wait = async enabled => {
    await settleMainFeatures();
    for (let i = 0; i < 100; i++) {
      const state = getMainFeatureProof();
      if (state.fresh && state.loaded && state.browserGate === (enabled ? true : null)) {
        assert.equal(state.mode, '3p'); assert.equal(state.sourceKind, 'static');
        assert.equal(state.staticCount, enabled ? 31 : 29); assert.equal(state.idleTimeout, 0);
        observations.push(state); return;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    throw Error('main feature source failed to settle to expected values');
  };
  try {
    const refusal = await call('triggerBootstrapAuth', [{bootstrapUrl: 'http://127.0.0.1:9/not-a-trusted-control-plane'}]);
    assert.equal(refusal.ok, false); assert.equal(typeof refusal.error, 'string');
    await wait(false);
    assert.equal((await call('writeConfig', [id, { ...initial.config, builtinBrowserEnabled: true }])).ok, true);
    await wait(true);
    // Multiple bridge writes may overlap provider account-refresh work.
    for (const enabled of [false, true, false]) {
      assert.equal((await call('writeConfig', [id, { ...initial.config, builtinBrowserEnabled: enabled }])).ok, true);
    }
    await wait(false);
    assert.equal((await call('writeConfig', [id, { ...initial.config, bootstrap: {
      url: 'https://api.anthropic.com/controlled-configuration', enabled: true,
    } }])).ok, true);
    await settleMainFeatures();
    const hybrid = getMainFeatureProof();
    assert.equal(hybrid.sourceKind, 'remote'); assert.equal(hybrid.hybrid, true);
    const authStatus = await call('getLoginDesktop3pStatus');
    assert.equal(authStatus.hybrid, true); assert.equal(authStatus.needsInteractiveAuth, true);
    assert.equal(hybrid.staticCount, null); assert.equal(hybrid.idleTimeout, 0);
    observations.push(hybrid);
    assert.equal((await call('writeConfig', [id, { ...initial.config, bootstrap: {
      url: 'https://api.anthropic.com/controlled-configuration', enabled: false,
    } }])).ok, true);
    await wait(false);
    report.slotStorage = proveHybridSlotStorage();
    assert.equal(report.slotStorage.encryptionAvailable, true);
    assert.equal(report.slotStorage.encrypted, true);
    assert.equal(report.slotStorage.roundTripped, true);
    report.observations = observations;
    report.realModelService = false;
    report.hybridAuthVerified = false;
    report.hybridNetworkFetchVerified = false;
    report.checks = { actualMainStaticReader: true, rendererConfigWriteReachedProvider: true,
      continuousWritesSettleToLastValue: true, readyAndFreshAfterStaticRefresh: true, idleFallbackRemainsZero: true,
      actualHybridSourceSelection: true, staticSourceRestoredAfterHybrid: true, actualElectronSlotEncryption: true, publicBootstrapAuthRejectsUntrustedUrl: true, publicHybridAuthRequirement: true };
  } finally { assert.equal((await call('writeConfig', [id, initial.config])).ok, true); await settleMainFeatures(); }
}
module.exports = { runMainFeaturesCheck };
