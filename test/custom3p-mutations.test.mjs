// The configuration mutations must actually mutate, and answer the list shape.
//
// None of them had a handler, so the generic fallback answered null and the UI threw.
// Measured live before the fix:
//   deleteConfig(...) -> null
//   consumer: let n = await e.deleteConfig(t); i(n.entries)
//   -> "Cannot read properties of null (reading 'entries')"
//
// The consumers (c71860c77):
//   createConfig(t)        -> `N(n.id)`                 needs .id
//   duplicateConfig(n, t)  -> `N(r.id)`                 needs .id
//   deleteConfig(t)        -> `i(n.entries), o(n.appliedId)`
//   renameConfig(n, t)     -> then optimistically patches the local list
//   setAppliedConfig(t)    -> then `o(t)`
//   writeConfig(id, body)  -> `bn(await ...)`           needs .ok
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionKernel } = require('../desktop/session-kernel.cjs');

const LIST_KEYS = ['entries', 'appliedId', 'isManaged', 'managedConfig', 'platform', 'isInternalBuild'];

/** A bridge over a throwaway library seeded with `seed` entries. */
function makeBridge(seed = [], relaunchApp, resetWindowBounds, onMainFeatureSourceChanged, auth = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-c3pm-'));
  const dir = path.join(root, 'Claude-3p', 'configLibrary');
  fs.mkdirSync(dir, { recursive: true });
  if (seed.length) {
    const entries = [];
    for (const s of seed) {
      fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s.config || {}, null, 2));
      entries.push({ id: s.id, name: s.name });
    }
    fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({
      entries,
      appliedId: seed[0].id,
    }, null, 2));
  }

  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;

  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const kernel = createSessionKernel({
    emit: () => {},
    createAgent: () => ({ model: 'm', tools: [], async run() { return { text: '', stopReason: 'end_turn' }; } }),
  });
  const { registerBridgeServices } = require('../desktop/bridge-services.cjs');
  const bridge = registerBridgeServices({
    onMainFeatureSourceChanged,
    ...auth,
    ipcMain,
    relaunchApp,
    resetWindowBounds,
    bridgeMap: require('../desktop/shim/bridge-map.json'),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    settings: { sidebarMode: 'epitaxy', themeMode: 'system', kernelFactory: () => kernel },
    frontend: { root: process.cwd() },
  });
  const call = (service, method, ...args) => {
    const channel = [...handlers.keys()].find(
      (c) => c.includes(`_$_${service}_$_`) && c.endsWith(`_$_${method}`),
    );
    if (!channel) throw new Error(`no handler for ${service}.${method}`);
    return handlers.get(channel)({}, ...args);
  };

  const restore = () => {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  };
  const meta = () => JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
  const bodyOf = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  const exists = (id) => fs.existsSync(path.join(dir, `${id}.json`));
  return { call, restore, dir, meta, bodyOf, exists, bridge };
}

const SEED = [
  { id: '11111111-1111-1111-1111-111111111111', name: 'CC Switch', config: { inferenceProvider: 'gateway' } },
  { id: '22222222-2222-2222-2222-222222222222', name: 'Backup', config: { inferenceProvider: 'anthropic' } },
];

test('createConfig answers an id the caller can open', async () => {
  // `let n = await e.createConfig(t); await j(); await N(n.id)`
  const { call, restore, meta, exists } = makeBridge(SEED);
  try {
    const result = await call('Custom3pSetup', 'createConfig', { name: 'Third' });
    assert.equal(result.ok, true, `create must succeed: ${JSON.stringify(result)}`);
    assert.equal(typeof result.id, 'string', 'the caller reads .id');
    assert.equal(exists(result.id), true, 'the config file must exist');
    assert.equal(meta().entries.length, 3, 'the entry must be recorded');
    assert.equal(meta().entries.find((e) => e.id === result.id).name, 'Third');
  } finally { restore(); }
});

test('createConfig answers the full list shape too', async () => {
  const { call, restore } = makeBridge(SEED);
  try {
    const result = await call('Custom3pSetup', 'createConfig', { name: 'Fourth' });
    for (const key of LIST_KEYS) assert.ok(key in result, `missing ${key}`);
  } finally { restore(); }
});

test('duplicateConfig copies the body and answers a new id', async () => {
  const { call, restore, bodyOf, exists } = makeBridge(SEED);
  try {
    const result = await call('Custom3pSetup', 'duplicateConfig', '11111111-1111-1111-1111-111111111111', { name: 'Copy' });
    assert.equal(result.ok, true);
    assert.equal(typeof result.id, 'string');
    assert.notEqual(result.id, '11111111-1111-1111-1111-111111111111', 'the duplicate must have its own id');
    assert.equal(exists(result.id), true);
    assert.deepEqual(bodyOf(result.id), bodyOf('11111111-1111-1111-1111-111111111111'), 'the body must be copied');
  } finally { restore(); }
});

test('renameConfig changes the name in _meta.json', async () => {
  const { call, restore, meta } = makeBridge(SEED);
  try {
    const result = await call('Custom3pSetup', 'renameConfig', '22222222-2222-2222-2222-222222222222', 'Renamed');
    assert.equal(result.ok, true);
    assert.equal(meta().entries.find((e) => e.id === '22222222-2222-2222-2222-222222222222').name, 'Renamed');
    // And the list reflects it.
    const list = await call('Custom3pSetup', 'listConfigs');
    assert.equal(list.entries.find((e) => e.id === '22222222-2222-2222-2222-222222222222').name, 'Renamed');
  } finally { restore(); }
});

test('renameConfig refuses an empty name', async () => {
  const { call, restore } = makeBridge(SEED);
  try {
    for (const bad of ['', '   ', null, undefined, 42]) {
      const result = await call('Custom3pSetup', 'renameConfig', '22222222-2222-2222-2222-222222222222', bad);
      assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    }
  } finally { restore(); }
});

test('deleteConfig removes the entry and answers entries/appliedId', async () => {
  // This is the one that threw "Cannot read properties of null (reading 'entries')".
  const { call, restore, meta, exists } = makeBridge(SEED);
  try {
    const result = await call('Custom3pSetup', 'deleteConfig', '22222222-2222-2222-2222-222222222222');
    assert.equal(result.ok, true, `delete must succeed: ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.entries), 'the caller reads .entries');
    assert.ok('appliedId' in result, 'and .appliedId');
    assert.equal(result.entries.length, 1);
    assert.equal(meta().entries.length, 1);
    assert.equal(exists('22222222-2222-2222-2222-222222222222'), false, 'the file must be gone');
  } finally { restore(); }
});

test('deleteConfig refuses to delete the applied config', async () => {
  // The app is running against it; removing it would leave the list pointing at nothing.
  const { call, restore, meta, exists } = makeBridge(SEED);
  try {
    const result = await call('Custom3pSetup', 'deleteConfig', '11111111-1111-1111-1111-111111111111');
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(meta().entries.length, 2, 'nothing may be removed');
    assert.equal(exists('11111111-1111-1111-1111-111111111111'), true);
  } finally { restore(); }
});

test('deleteConfig refuses an unknown id', async () => {
  const { call, restore, meta } = makeBridge(SEED);
  try {
    const result = await call('Custom3pSetup', 'deleteConfig', 'no-such-config');
    assert.equal(result.ok, false);
    assert.equal(meta().entries.length, 2);
  } finally { restore(); }
});

test('setAppliedConfig moves appliedId and the list agrees', async () => {
  const { call, restore, meta } = makeBridge(SEED);
  try {
    const result = await call('Custom3pSetup', 'setAppliedConfig', '22222222-2222-2222-2222-222222222222');
    assert.equal(result, undefined);
    assert.equal(meta().appliedId, '22222222-2222-2222-2222-222222222222');

    const list = await call('Custom3pSetup', 'listConfigs');
    assert.equal(list.appliedId, '22222222-2222-2222-2222-222222222222');
    assert.equal(list.entries.find((e) => e.id === '22222222-2222-2222-2222-222222222222').applied, true);
    assert.equal(list.entries.find((e) => e.id === '11111111-1111-1111-1111-111111111111').applied, false);
  } finally { restore(); }
});

test('setAppliedConfig refuses an unknown id', async () => {
  const { call, restore, meta } = makeBridge(SEED);
  try {
    await assert.rejects(() => call('Custom3pSetup', 'setAppliedConfig', 'no-such-config'), /unknown config id/);
    assert.equal(meta().appliedId, '11111111-1111-1111-1111-111111111111', 'the applied id must not change');
  } finally { restore(); }
});

test('writeConfig persists the body and answers an object with ok', async () => {
  // `bn(await e.writeConfig(r.id, n))` checks `.ok`, so a bare value would be wrong.
  const { call, restore, bodyOf } = makeBridge(SEED);
  try {
    // A static gateway profile needs the credential the shipped editor requires.
    const body = { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'https://new.invalid', inferenceGatewayApiKey: 'fixture-key' };
    const result = await call('Custom3pSetup', 'writeConfig', '11111111-1111-1111-1111-111111111111', body);
    assert.equal(typeof result, 'object');
    assert.equal(result.ok, true);
    assert.deepEqual(bodyOf('11111111-1111-1111-1111-111111111111'), body);
  } finally { restore(); }
});

test('writeConfig refuses an invalid body or unknown id', async () => {
  const { call, restore, bodyOf } = makeBridge(SEED);
  try {
    const before = bodyOf('11111111-1111-1111-1111-111111111111');
    for (const bad of [null, undefined, 'text', 42, []]) {
      assert.equal((await call('Custom3pSetup', 'writeConfig', '11111111-1111-1111-1111-111111111111', bad)).ok, false);
    }
    assert.equal((await call('Custom3pSetup', 'writeConfig', 'nope', { a: 1 })).ok, false);
    assert.deepEqual(bodyOf('11111111-1111-1111-1111-111111111111'), before, 'nothing may be written');
  } finally { restore(); }
});

test('listSwitchableProfiles answers an array the caller can map', async () => {
  // `r = n.map(i)` -- null would throw here once the `?? CG` is not in the path.
  const { call, restore } = makeBridge(SEED);
  try {
    const result = await call('Custom3pSetup', 'listSwitchableProfiles');
    assert.ok(Array.isArray(result), `expected an array, got ${JSON.stringify(result)}`);
    assert.equal(result.length, 2);
    for (const p of result) {
      assert.equal(typeof p.name, 'string');
      assert.equal(typeof p.provider, 'string');
    }
  } finally { restore(); }
});

test('listSwitchableProfiles answers an empty array with no library', async () => {
  const { call, restore } = makeBridge([]);
  try {
    const result = await call('Custom3pSetup', 'listSwitchableProfiles');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  } finally { restore(); }
});

test('the full create -> write -> apply -> delete lifecycle works', async () => {
  // What the UI does end to end, in order.
  const { call, restore, meta } = makeBridge(SEED);
  try {
    const created = await call('Custom3pSetup', 'createConfig', { name: 'Lifecycle' });
    assert.equal(created.ok, true);
    const id = created.id;

    assert.equal((await call('Custom3pSetup', 'writeConfig', id, { inferenceProvider: 'x' })).ok, true);
    assert.equal(await call('Custom3pSetup', 'setAppliedConfig', id), undefined);
    assert.equal(meta().appliedId, id);

    // It is applied now, so deleting it must be refused.
    assert.equal((await call('Custom3pSetup', 'deleteConfig', id)).ok, false);

    // Apply something else, then it can go.
    assert.equal(await call('Custom3pSetup', 'setAppliedConfig', '11111111-1111-1111-1111-111111111111'), undefined);
    assert.equal((await call('Custom3pSetup', 'deleteConfig', id)).ok, true);
    assert.equal(meta().entries.length, 2);
  } finally { restore(); }
});

test('apply persists deployment mode while preserving desktop settings and hybrid pointer semantics', async () => {
  const { call, restore, dir, meta } = makeBridge(SEED);
  try {
    const file = path.join(path.dirname(dir), 'claude_desktop_config.json');
    fs.writeFileSync(file, JSON.stringify({ deploymentMode: 'consumer', preferences: { theme: 'dark' } }));
    const before = meta(); before.hybridPointer = { bootstrapUrl: 'https://dummy.invalid' };
    fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify(before));
    assert.equal(await call('Custom3pSetup', 'setAppliedConfig', SEED[0].id), undefined);
    assert.deepEqual(meta().hybridPointer, before.hybridPointer);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { deploymentMode: '3p', preferences: { theme: 'dark' } });
    await call('Custom3pSetup', 'setAppliedConfig', SEED[1].id);
    assert.equal('hybridPointer' in meta(), false);
  } finally { restore(); }
});

test('apply initializes a default library for missing or syntactically corrupt metadata', async () => {
  for (const corrupt of [false, true]) {
    const { call, restore, dir, meta } = makeBridge(SEED);
    try {
      const metaFile = path.join(dir, '_meta.json');
      if (corrupt) fs.writeFileSync(metaFile, '{broken');
      else fs.unlinkSync(metaFile);
      await assert.rejects(() => call('Custom3pSetup', 'setAppliedConfig', SEED[1].id), /unknown config id/);
      const recovered = meta();
      assert.equal(recovered.entries.length, 1);
      assert.equal(recovered.entries[0].name, 'Default');
      assert.equal(recovered.appliedId, recovered.entries[0].id);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${recovered.appliedId}.json`), 'utf8')), {});
    } finally { restore(); }
  }
});

test('apply rejects corrupt desktop config after metadata persistence', async () => {
  const { call, restore, dir, meta } = makeBridge(SEED);
  try {
    const metaFile = path.join(dir, '_meta.json');
    const desktopFile = path.join(path.dirname(dir), 'claude_desktop_config.json');
    fs.writeFileSync(desktopFile, '{broken');
    await assert.rejects(() => call('Custom3pSetup', 'setAppliedConfig', SEED[1].id));
    assert.equal(meta().appliedId, SEED[1].id);
    assert.equal(fs.readFileSync(desktopFile, 'utf8'), '{broken');
  } finally { restore(); }
});

test('apply updates the mode cache and ignores renderer skip arguments', async () => {
  let resets = 0;
  const { call, restore, dir } = makeBridge(SEED, undefined, () => { resets++; });
  try {
    fs.writeFileSync(path.join(path.dirname(dir), 'claude_desktop_config.json'), JSON.stringify({ deploymentMode: '1p' }));
    assert.equal((await call('AppConfig', 'getAppConfig')).deploymentMode, '1p');
    assert.equal(await call('Custom3pSetup', 'setAppliedConfig', SEED[1].id, { skipWindowBoundsReset: true }), undefined);
    assert.equal((await call('AppConfig', 'getAppConfig')).deploymentMode, '3p');
    assert.equal(resets, 1);
    await call('Custom3pSetup', 'setAppliedConfig', SEED[1].id);
    assert.equal(resets, 1);
  } finally { restore(); }
});

test('apply propagates a real metadata write failure', async () => {
  const { call, restore, dir, meta } = makeBridge(SEED);
  try {
    fs.mkdirSync(path.join(dir, `_meta.json.tmp-${process.pid}`));
    await assert.rejects(() => call('Custom3pSetup', 'setAppliedConfig', SEED[1].id));
    assert.equal(meta().appliedId, SEED[0].id);
  } finally { restore(); }
});

test('apply only checks metadata and defers missing profile detection', async () => {
  const { call, restore, dir, meta } = makeBridge(SEED);
  try {
    fs.unlinkSync(path.join(dir, `${SEED[1].id}.json`));
    assert.equal(await call('Custom3pSetup', 'setAppliedConfig', SEED[1].id), undefined);
    assert.equal(meta().appliedId, SEED[1].id);
    assert.equal((await call('Custom3pSetup', 'readConfig', SEED[1].id)).ok, false);
  } finally { restore(); }
});

test('apply reports desktop config write failure after metadata persistence', async () => {
  const { call, restore, dir, meta } = makeBridge(SEED);
  try {
    const file = path.join(path.dirname(dir), 'claude_desktop_config.json');
    fs.mkdirSync(`${file}.tmp-${process.pid}`);
    await assert.rejects(() => call('Custom3pSetup', 'setAppliedConfig', SEED[1].id));
    assert.equal(meta().appliedId, SEED[1].id);
    assert.equal(fs.existsSync(file), false);
  } finally { restore(); }
});

test('relaunchApp calls the injected lifecycle once without arguments and resolves undefined', async () => {
  const calls = [];
  const { call, restore } = makeBridge(SEED, (...args) => { calls.push(args); });
  try {
    assert.equal(await call('Custom3pSetup', 'relaunchApp', 'ignored'), undefined);
    assert.deepEqual(calls, [[]]);
  } finally { restore(); }
});

test('relaunchApp rejects when lifecycle is not injected', async () => {
  const { call, restore } = makeBridge(SEED);
  try {
    await assert.rejects(() => call('Custom3pSetup', 'relaunchApp'), /app relaunch unavailable/);
  } finally { restore(); }
});


test('main feature source is notified after deployment mode changes to 3p', async () => {
  const seen = [];
  const h = makeBridge(SEED, undefined, undefined, () => seen.push(h.bridge.getMainGrowthBookContext().mode));
  try {
    fs.writeFileSync(path.join(h.dir, '..', 'claude_desktop_config.json'), JSON.stringify({deploymentMode:'1p'}));
    assert.equal(h.bridge.getMainGrowthBookContext().mode, '1p');
    await h.call('Custom3pSetup', 'setAppliedConfig', SEED[0].id);
    assert.equal(seen.at(-1), '3p');
    assert.equal(Object.keys(h.bridge.getMainGrowthBookContext().source.features).length, 29);
  } finally { h.bridge.dispose(); h.restore(); }
});


test('bootstrap auth bridge normalizes results and exposes current auth requirement without tokens', async () => {
  let failure, supplied; const status={hybrid:true,needsInteractiveAuth:true};
  const h=makeBridge(SEED,undefined,undefined,undefined,{getBootstrapAuthStatus:()=>status,triggerBootstrapAuth:async args=>{
    supplied=args;if(failure)throw failure;return {accessToken:'synthetic-must-not-escape'};
  }});
  try {
    const args={bootstrapUrl:'https://api.anthropic.com/bootstrap'};
    assert.deepEqual(await h.call('Custom3pSetup','triggerBootstrapAuth',args),{ok:true}); assert.deepEqual(supplied,args);
    const current=await h.call('Custom3pSetup','getLoginDesktop3pStatus');assert.equal(current.hybrid,true);assert.equal(current.needsInteractiveAuth,true);
    failure=Error('fixture refusal');assert.deepEqual(await h.call('Custom3pSetup','triggerBootstrapAuth',args),{ok:false,error:'fixture refusal'});
    failure=Object.assign(Error('cancelled'),{name:'AbortError'});assert.deepEqual(await h.call('Custom3pSetup','triggerBootstrapAuth',args),{ok:false,error:'cancelled'});
    failure=null;await h.call('Custom3pSetup','triggerBootstrapAuth');
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir,'..','claude_desktop_config.json'))).deploymentMode,'3p');
  } finally {h.bridge.dispose();h.restore();}
});
