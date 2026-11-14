import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMainGrowthBookRuntime } = require('../desktop/main-growthbook-runtime.cjs');
const { createGrowthBookProvider } = require('../desktop/growthbook-provider.cjs');
const { createCliMcpGateSource } = require('../desktop/cli-mcp-host-sources.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = () => ({ ok:true, json:async () => ({ features:{ '513873720':{ on:true, value:true } } }) });

test('source refresh invalidates gate before reproject and restores only after current source succeeds', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cli-security-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  let identity = 'a', pending;
  const context = () => ({ mode:'3p', source:{ kind:'remote', identity, fetch:() => pending ? pending.promise : Promise.resolve(reply()),
    hardcodedFeatures:{}, remoteAllowedKeys:['513873720'] } });
  const runtime = createMainGrowthBookRuntime({ getContext:context, userData:dir, providerOptions:{ setTimer:() => 1, clearTimer() {} } });
  const gate = createCliMcpGateSource();
  const notices = [];
  gate.subscribe(() => { notices.push(gate.read()); });
  gate.attach(runtime);
  await runtime.init();
  const old = await gate.read();
  assert.equal(old.complete, true);
  assert.equal(old.featureEnabled, true);
  pending = deferred(); identity = 'b';
  gate.invalidate();
  const work = runtime.refreshSource();
  assert.equal((await gate.read()).complete, false);
  assert.equal(gate.isCurrent(old), false);
  assert.equal(runtime.getFeatureValue('513873720', false), true);
  const observed = await Promise.all(notices.splice(0));
  assert.equal(observed.at(-1).complete, false);
  pending.resolve(reply());
  await work;
  assert.equal((await gate.read()).complete, true);
  assert.equal((await gate.read()).featureEnabled, true);
  gate.dispose(); runtime.dispose();
});

test('security freshness changes in both directions, survives reentry and rejects missing 1p identity', async () => {
  let account = 'a';
  const requests = [];
  const provider = createGrowthBookProvider({ getContext:() => ({ mode:'1p', accountKey:account, orgUuid:'org',
    source:{ kind:'remote', fetch:() => { const next=deferred(); requests.push(next); return next.promise; } } }),
    setTimer:() => 1, clearTimer() {} });
  const changes = [];
  provider.onSecurityFreshnessChange(value => { changes.push(value); assert.equal(provider.isSecurityFreshForCurrentSource(), value); });
  const init = provider.init(); requests[0].resolve(reply()); await init;
  assert.equal(provider.isSecurityFreshForCurrentSource(), true);
  account = 'b';
  assert.equal(provider.isSecurityFreshForCurrentSource(), false);
  const work = provider.accountChanged();
  requests[1].resolve(reply()); await work;
  assert.equal(provider.isSecurityFreshForCurrentSource(), true);
  assert.deepEqual(changes, [true, false, true]);
  account = undefined;
  const missing = provider.accountChanged();
  requests[2].resolve(reply()); await missing;
  assert.equal(provider.isSecurityFreshForCurrentSource(), false);
  provider.dispose();
});

test('late old source and failed new source cannot restore gate; later successful refresh can', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cli-security-race-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  let identity = 'a';
  const queue = [];
  const runtime = createMainGrowthBookRuntime({ userData:dir, providerOptions:{ setTimer:() => 1, clearTimer() {} },
    getContext:() => ({ mode:'3p', source:{ kind:'remote', identity, fetch:() => { const d=deferred(); queue.push(d); return d.promise; } } }) });
  const gate = createCliMcpGateSource(); gate.attach(runtime);
  const init = runtime.init(); queue[0].resolve(reply()); await init;
  assert.equal((await gate.read()).complete, true);
  const old = runtime.refresh({ force:true });
  identity = 'b'; gate.invalidate();
  const changed = runtime.refreshSource();
  queue[1].resolve(reply()); await old;
  assert.equal((await gate.read()).complete, false);
  queue[2].resolve({ ok:false }); await changed;
  assert.equal((await gate.read()).complete, false);
  const retry = runtime.refreshSource();
  queue[3].resolve(reply()); await retry;
  assert.equal((await gate.read()).complete, true);
  gate.dispose(); runtime.dispose();
});

test('reentrant source replacement during feature notification cannot approve old data', async () => {
  let identity = 'a';
  const provider = createGrowthBookProvider({ getContext:() => ({ mode:'3p', source:{ kind:'remote', identity, fetch:async () => reply() } }),
    setTimer:() => 1, clearTimer() {} });
  provider.observeFeatureGate('513873720', () => { identity = 'b'; provider.getFeatureValue('513873720', false); });
  await provider.init();
  assert.equal(provider.getFeatureValue('513873720', false), true);
  assert.equal(provider.isSecurityFreshForCurrentSource(), false);
  provider.dispose();
});

test('remote to static certifies only gate supplied by current static policy, preserving ordinary projection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cli-static-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  let source = { kind:'remote', identity:'hybrid', fetch:async () => ({ ok:true, json:async () => ({ features:{
    '513873720':{ on:true, value:true }, retained:{ on:true, value:'old' } } }) }) };
  const runtime = createMainGrowthBookRuntime({ userData:dir, providerOptions:{ setTimer:() => 1, clearTimer() {} }, getContext:() => ({ mode:'3p', source }) });
  const gate = createCliMcpGateSource(); gate.attach(runtime);
  await runtime.init();
  assert.equal((await gate.read()).featureEnabled, true);
  source = { kind:'static', identity:'static', features:{}, remoteAllowedKeys:new Set(['retained']) };
  gate.invalidate(); await runtime.refreshSource();
  const state = await gate.read();
  assert.equal(state.complete, true);
  assert.equal(state.featureEnabled, false);
  assert.equal(runtime.getFeatureValue('retained', null), 'old');
  gate.dispose(); runtime.dispose();
});

test('a static allowlist retaining an old remote gate cannot certify that gate', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cli-allow-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  let source = { kind:'remote', identity:'a', fetch:async () => reply() };
  const runtime = createMainGrowthBookRuntime({ userData:dir, providerOptions:{ setTimer:() => 1, clearTimer() {} }, getContext:() => ({ mode:'3p', source }) });
  const gate = createCliMcpGateSource(); gate.attach(runtime);
  await runtime.init();
  source = { kind:'static', identity:'b', features:{}, remoteAllowedKeys:['513873720'] };
  gate.invalidate(); await runtime.refreshSource();
  assert.equal(runtime.getFeatureValue('513873720', false), true);
  assert.equal((await gate.read()).complete, false);
  gate.dispose(); runtime.dispose();
});

test('same identity reentrant refresh cannot approve the older in-flight response', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cli-reenter-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const queue = [];
  const runtime = createMainGrowthBookRuntime({ userData:dir, providerOptions:{ setTimer:() => 1, clearTimer() {} },
    getContext:() => ({ mode:'3p', source:{ kind:'remote', identity:'same', fetch:() => { const d=deferred(); queue.push(d); return d.promise; } } }) });
  const gate = createCliMcpGateSource(); gate.attach(runtime);
  let nested;
  runtime.observeFeatureGate('513873720', () => { if (!nested) { gate.invalidate(); nested = runtime.refreshSource(); } });
  const init = runtime.init(); queue[0].resolve(reply()); await init;
  assert.equal((await gate.read()).complete, false);
  assert.equal(queue.length, 2);
  queue[1].resolve(reply()); await nested;
  assert.equal((await gate.read()).complete, true);
  assert.equal((await gate.read()).featureEnabled, true);
  gate.dispose(); runtime.dispose();
});
