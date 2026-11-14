import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { createGrowthBookProvider, encodeFeatureCache, decodeFeatureCache } = require('../desktop/growthbook-provider.cjs');
const magic = Buffer.from([67,76,70,2,0,154,183,226]);
const feature = (value, source = 'default') => ({ on: !!value, value, source });
const ok = features => ({ ok: true, json: async () => ({ features }) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const make = (context, options = {}) => createGrowthBookProvider({ getContext: () => context, setTimer: () => 1, clearTimer() {}, ...options });

test('fcache wire format, age, mode, org and corrupt data', async () => {
  const bytes = await encodeFeatureCache({ timestamp: 100, mode: 'a', orgUuid: 'one', features: { x: feature(1) } });
  assert.ok(bytes.subarray(0,8).equals(magic));
  const read = opts => decodeFeatureCache(bytes, { now: 100, mode: 'a', ...opts });
  assert.equal((await read()).x.value, 1);
  assert.ok(await read({ now: 100 + 86400000 }));
  assert.equal(await read({ now: 101 + 86400000 }), null);
  assert.equal(await read({ mode: 'b' }), null);
  assert.equal(await read({ restricted: true, orgUuid: 'two' }), null);
  assert.equal(await read({ restricted: true }), null);
  assert.ok(await read({ restricted: true, orgUuid: 'one' }));
  assert.equal(await decodeFeatureCache(Buffer.concat([magic, Buffer.from('bad')]), { mode: 'a' }), null);
  const legacy = Buffer.concat([magic, gzipSync(JSON.stringify({ mode:'a', features:{x:1} }))]);
  assert.deepEqual(await decodeFeatureCache(legacy, { mode:'a' }), { x:1 });
});

test('network failure reads cache, applies hardcoded allowlist and observes removal', async () => {
  const bytes = await encodeFeatureCache({ timestamp: 0, mode:'a', features:{x:feature(2), y:feature(3)} });
  const ctx = { mode:'a', source:{kind:'remote', fetch:async()=>{throw Error('offline')}, hardcodedFeatures:{z:feature(4)}, remoteAllowedKeys:['x']} };
  const p = make(ctx, { now:()=>0, cache:{read:async()=>bytes} });
  assert.equal(await p.init(), 'network-error');
  assert.equal(p.getFeatureValue('x', 0), 2); assert.equal(p.getFeatureValue('y', 0), 0); assert.equal(p.getFeatureValue('z', 0), 4);
  const events=[]; p.observeFeature('x', v=>events.push(v));
  ctx.source.fetch=async()=>ok({});
  await p.refresh();
  assert.deepEqual(events, [undefined]); p.dispose();
});

test('refresh coalesces, throttles and ignores source-only change', async () => {
  let calls=0; let next = deferred();
  const ctx = {mode:'a', source:{kind:'remote', fetch:()=>{calls++; return next.promise}}};
  const p = make(ctx, { now:()=>0 }); const first=p.init(); const second=p.refresh();
  assert.equal(calls,1); next.resolve(ok({x:feature(1)})); await Promise.all([first,second]);
  assert.equal(await p.refresh(), 'throttled');
  let seen=0; p.observeFeature('x',()=>seen++); next=deferred(); const update=p.refresh({force:true}); next.resolve(ok({x:feature(1,'changed')})); await update;
  assert.equal(seen,0); p.dispose();
});

test('account refresh waits for old request and discards stale completion', async () => {
  const old=deferred(), fresh=deferred(); let calls=0;
  const ctx={mode:'a', accountKey:'old', source:{kind:'remote', fetch:()=> (++calls === 1 ? old.promise : fresh.promise)}};
  const p=make(ctx); const init=p.init(); ctx.accountKey='new'; const change=p.accountChanged();
  assert.equal(calls,1); old.resolve(ok({x:feature('old')})); await init; await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2); assert.equal(p.getFeatureValue('x','missing'),'missing');
  fresh.resolve(ok({x:feature('new')})); await change; assert.equal(p.getFeatureValue('x','missing'),'new'); p.dispose();
});

test('anonymous refusal keeps existing network and falls back according to authentication latch', async () => {
  const ctx={mode:'a', source:{kind:'remote', hybrid:true, hardcodedFeatures:{local:feature(7)}, fetch:async()=>({ok:true,json:async()=>({user:null,features:{x:feature(1)}})})}};
  const p=make(ctx); assert.equal(await p.init(),'anon-refused'); assert.equal(p.getFeatureValue('local',0),7);
  ctx.source.fetch=async()=>({ok:true,json:async()=>({user:{id:1},features:{x:feature(2)}})}); await p.refresh({force:true});
  ctx.source.fetch=async()=>({ok:true,json:async()=>({user:null,features:{x:feature(3)}})}); await p.refresh({force:true});
  // The hardcoded projection only admits remote keys explicitly listed.
  assert.equal(p.getFeatureValue('local',0),7); p.dispose();
});
