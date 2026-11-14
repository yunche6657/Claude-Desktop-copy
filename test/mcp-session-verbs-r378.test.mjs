import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { createMcpSessionVerbs, normalizeUrl, validateEnable } = createRequire(import.meta.url)('../desktop/mcp-session-verbs.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('URL normalization and enable eligibility match shipped helpers', () => {
  const base = path.resolve('../ccd-ref/asar/.vite/build');
  const s = fs.readFileSync(path.join(base, 'index.chunk-Bn6onBlX.js'), 'utf8');
  const method = s.slice(s.indexOf('function rj('), s.indexOf('function ij(', s.indexOf('function rj(')));
  const native = vm.runInNewContext(`(()=>{let QA=new Set(['local','user','project','flag','enterprise','managed','agent']),$A=/^plugin:[^:]+:.+$/,ej='Unknown MCP server for this session',tj="This server can't be turned on from here",nj=/\\bmanaged (?:MCP )?policy\\b/i;${method}return rj})()`);
  const cases = [[], [{name:'s',status:'disabled',scope:'user'}], [{name:'s',status:'disabled',scope:'dynamic'}],
    [{name:'plugin:x:y',status:'disabled',scope:'dynamic'}], [{name:'s',status:'failed',error:'blocked by managed MCP policy'}],
    [{name:'s',status:'disabled',scope:'user',origin:'app'}], [{name:'s',status:'connected'}], [{name:'s'}, {name:'s'}]];
  for (const rows of cases) {
    const name = rows[0]?.name ?? 's', expected = native(rows, name), actual = validateEnable(rows, name);
    assert.deepEqual(actual, expected?.error ? JSON.parse(JSON.stringify(expected)) : null);
  }
  const lza = fs.readFileSync(path.join(base, 'index.chunk-lzaSYO3Q.js'), 'utf8');
  const start = lza.indexOf('function XTe('), end = lza.indexOf('function ls(', start);
  const nativeUrl = vm.runInNewContext(`(()=>{${lza.slice(start,end)}return XTe})()`, { URL });
  for (const url of ['https://EXAMPLE.com:443/a/', 'https://example.com/', 'https://example.com/a/?x=1', 'not a url']) assert.equal(normalizeUrl(url), nativeUrl(url));
});

function setup() {
  let actor='a', generation=1, wait=false, bindingVersion=1;
  let rows=[{ name:'server', status:'failed', scope:'user', transport:'http', config:{url:'https://example.com/mcp/'} }];
  let bindingKind='verified', bindingUrl='https://example.com/mcp';
  const calls=[], queued=[];
  const deps = { getSession:() => ({ backend:{kind:'local'} }), getActorToken:() => actor, getSessionGeneration:() => generation,
    isSupportedSession:() => true,
    getStatus:() => ({ actorToken:actor, servers:rows }),
    async refreshStatus(_id, token) { calls.push('status'); return { actorToken:token, servers:rows }; },
    async reconnect(_id, token) { calls.push('reconnect'); rows=[{...rows[0], status:'connected'}]; return { actorToken:token }; },
    async toggle(_id, token, _name, enabled) { calls.push(`toggle:${enabled}`); rows=[{...rows[0], status:'connected'}]; return { actorToken:token }; },
    getAuthBinding() { const captured=bindingVersion; return { kind:bindingKind, url:bindingUrl, isCurrent:() => captured === bindingVersion }; },
    controlRequestsWait:() => wait, async queue(item) { queued.push(item); return true; } };
  return { deps, verbs:createMcpSessionVerbs(deps), calls, queued, setRows:value => { rows=value; }, setActor:value => { actor=value; },
    setWait:value => { wait=value; }, setBinding:(kind,url) => { bindingKind=kind; bindingUrl=url; bindingVersion++; }, invalidateBinding:() => { bindingVersion++; }, replaceSession:() => { generation++; } };
}

test('reconnect requires verified full URL, checks actor and confirms status', async () => {
  const f=setup();
  assert.deepEqual(await f.verbs.mcpReconnect('s','server'), {});
  assert.deepEqual(f.calls, ['status','reconnect','status']);
  const g=setup(); g.setBinding('verified','https://example.com/other');
  assert.match((await g.verbs.mcpReconnect('s','server')).error,/different server URL/);
  assert.deepEqual(g.calls, ['status']);
  const h=setup(); h.setBinding('unverified');
  assert.match((await h.verbs.mcpReconnect('s','server')).error,/verify/);
  assert.deepEqual(h.calls, []);
});

test('retry and enable use separate status and queue rules', async () => {
  const f=setup(); f.setBinding('unverified');
  assert.deepEqual(await f.verbs.mcpRetryConnection('s','server'), {});
  assert.deepEqual(f.calls, ['reconnect','status']);
  const g=setup(); g.setRows([{name:'server',status:'disabled',scope:'user'}]); g.setWait(true);
  assert.deepEqual(await g.verbs.mcpEnableServer('s','server'), {queued:true,error:'Turn in progress'});
  assert.equal(g.queued[0].actorToken, 'a'); assert.deepEqual(g.calls, []);
  const h=setup(); h.setRows([{name:'server',status:'disabled',scope:'dynamic'}]);
  assert.match((await h.verbs.mcpEnableServer('s','server')).error,/can't be turned on/);
  const k=setup(); k.setRows([{name:'server',status:'disabled',scope:'user'}]);
  assert.deepEqual(await k.verbs.mcpEnableServer('s','server'), {});
  assert.deepEqual(k.calls,['status','toggle:true','status']);
});

test('enable never reports success when the shared gate did not dispatch toggle',async()=>{
 for(const code of ['MCP_CONTROL_BUSY','MCP_CONTROL_UNCERTAIN','CCB_CONTROL_TIMEOUT']) {
  const f=setup();f.setRows([{name:'server',status:'failed',scope:'user'}]);
  f.deps.formatError=e=>e.message;f.deps.toggle=async()=>{throw Object.assign(new Error('gate refused'),{code})};
  assert.deepEqual(await f.verbs.mcpEnableServer('s','server'),{error:'gate refused'});
  assert.deepEqual(f.calls,['status']);
 }
});

test('config-auth reconnect checks the full URL and retires only after confirmation', async () => {
 const f=setup(), completed=[]; f.setBinding('config-auth','https://example.com/mcp');
 f.deps.completeReconnect=(...args)=>completed.push(args);
 assert.deepEqual(await f.verbs.mcpReconnect('s','server'),{});
 assert.deepEqual(f.calls,['status','reconnect','status']);
 assert.equal(completed.length,1);assert.deepEqual(completed[0].slice(0,3),['s','server','a']);
 const mismatch=setup(); mismatch.setBinding('config-auth','https://example.com/different');
 mismatch.deps.completeReconnect=()=>assert.fail('mismatched URL must not complete');
 assert.match((await mismatch.verbs.mcpReconnect('s','server')).error,/configuration changed/);
 assert.deepEqual(mismatch.calls,['status']);
 const retry=setup(); retry.setBinding('config-auth','https://example.com/different');
 assert.deepEqual(await retry.verbs.mcpRetryConnection('s','server'),{});
 assert.deepEqual(retry.calls,['reconnect','status']);
});

test('native reconnect validates config-auth URL and clears its binding after success', async () => {
 const source=fs.readFileSync(path.resolve('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js'),'utf8');
 const start=source.indexOf('async mcpReconnect('),end=source.indexOf('async mcpRetryConnection(',start);
 assert.ok(start>=0&&end>start);const method=source.slice(start,end),checks=[];
 const nativeFactory=vm.runInNewContext(`(deps)=>({deps,retireHeldMcpVerb(){},${method}})`,{
  RA:60000,HA:5000,zA:Symbol('timeout'),Date,Error,setTimeout,clearTimeout,
  bj:async(_s,name,url)=>{checks.push([name,url]);return null},fx:(_s,_q,p)=>p,
  t:{L5:{warn(){},info(){},error(){}},M4:s=>s}});
 const query={reconnectMcpServer:async()=>{}}, session={query,verifiedMcpServerUrls:new Map([['server','https://example.com/mcp']]),configMcpAuthServers:new Set(['server'])};
 const native=nativeFactory({getSession:()=>session,refreshSdkMcpStatuses:async()=>[{name:'server',status:'connected'}]});
 assert.deepEqual(JSON.parse(JSON.stringify(await native.mcpReconnect('s','server'))),{});
 assert.deepEqual(checks,[['server','https://example.com/mcp']]);
 assert.equal(session.verifiedMcpServerUrls.has('server'),false);assert.equal(session.configMcpAuthServers.has('server'),false);
});

test('stale actor or binding never causes a control and duplicate retry is rejected', async () => {
  const f=setup(), pending=deferred();
  f.deps.refreshStatus=() => pending.promise;
  const first=f.verbs.mcpRetryConnection('s','server');
  const second=f.verbs.mcpRetryConnection('s','server');
  f.setActor('b');
  pending.resolve({actorToken:'a',servers:[{name:'server',status:'failed',config:{url:'https://example.com/mcp'}}]});
  assert.deepEqual(await first,{error:'Session not running'});
  assert.deepEqual(await second,{error:'Session not running'});
  assert.deepEqual(f.calls,[]);
  const g=setup(), next=deferred(); g.deps.refreshStatus=() => next.promise;
  const operation=g.verbs.mcpReconnect('s','server'); g.invalidateBinding();
  next.resolve({actorToken:'a',servers:[{name:'server',status:'failed',config:{url:'https://example.com/mcp'}}]});
  assert.match((await operation).error,/verify/); assert.deepEqual(g.calls,[]);
});

test('unknown session, uncertain host state, and duplicates fail closed', async () => {
  const f=setup(); f.deps.getSession=()=>null;
  assert.deepEqual(await f.verbs.mcpReconnect('s','server'),{error:'Session not running'});
  const g=setup(); g.deps.controlRequestsWait=()=>undefined;
  assert.deepEqual(await g.verbs.mcpRetryConnection('s','server'),{error:'MCP session state unavailable'});
  const h=setup(); h.setRows([{name:'server',status:'failed'}, {name:'server',status:'failed'}]);
  assert.match((await h.verbs.mcpRetryConnection('s','server')).error,/Ambiguous/);
  assert.deepEqual(h.calls,[]);
});

test('preflight and confirmation have 60 second and 5 second deadlines', async () => {
  const f=setup(), timers=[];
  f.deps.setTimer=(fn,ms) => { const timer={fn,ms}; timers.push(timer); return timer; };
  f.deps.clearTimer=timer => { timer.cleared=true; };
  const stalled=deferred(), started=deferred();
  f.deps.refreshStatus=() => { started.resolve(); return stalled.promise; };
  const operation=createMcpSessionVerbs(f.deps).mcpReconnect('s','server');
  await started.promise;
  assert.equal(timers[0].ms,60000);
  timers[0].fn();
  assert.deepEqual(await operation,{error:"Reconnect didn't start"});
  assert.deepEqual(f.calls,[]);
  stalled.resolve({actorToken:'a',servers:[]});

  const g=setup(), timers2=[], confirmStarted=deferred();
  g.deps.setTimer=(fn,ms) => { const timer={fn,ms}; timers2.push(timer); return timer; };
  g.deps.clearTimer=timer => { timer.cleared=true; };
  let count=0;
  g.deps.refreshStatus=(_id,token) => {
    count++;
    if (count === 1) return Promise.resolve({actorToken:token,servers:[{name:'server',status:'failed',config:{url:'https://example.com/mcp'}}]});
    confirmStarted.resolve(); return new Promise(() => {});
  };
  const confirm=createMcpSessionVerbs(g.deps).mcpReconnect('s','server');
  await confirmStarted.promise;
  assert.equal(timers2.at(-1).ms,5000);
  timers2.at(-1).fn();
  assert.deepEqual(await confirm,{error:'Reconnect timed out'});
  assert.deepEqual(g.calls,['reconnect']);
});


test('retry without URL binding and enable confirmation match shipped methods', async () => {
  const source=fs.readFileSync(path.resolve('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js'),'utf8');
  const retry=source.slice(source.indexOf('async mcpRetryConnection('),source.indexOf('async mcpClearAuth('));
  const enable=source.slice(source.indexOf('async mcpEnableServer('),source.indexOf('mcpRetryInFlightKeys()'));
  const sandbox={ RA:60000, HA:5000, zA:Symbol('timeout'), Date, Error, setTimeout, clearTimeout,
    RO:()=>true, rj:(rows,name)=>validateEnable(rows,name), ij:s=>s.startsWith('MCP server ')&&s.endsWith(' is blocked by enterprise managed policy')?'managed_policy':undefined,
    BA:async p=>p, fx:(_session,_query,p)=>p, oj:(id,name)=>`${id}\0${name}`,
    t:{L5:{warn(){},info(){},error(){}},M4:s=>s,cz(){}}, h:{n:s=>s} };
  const factory=vm.runInNewContext(`(deps,session)=>({deps,mcpRetryInFlight:new Map(), foundGoneOf:()=>new Set(),book:()=>undefined, ${retry}, ${enable}})`,sandbox);
  for (const scenario of ['ok','disabled','error-recovered','error-policy','error-unconfirmed']) {
    let rows=[{name:'server',status:'disabled',scope:'user'}];
    const failure=scenario.startsWith('error') ? new Error(scenario==='error-policy'?'MCP server server is blocked by enterprise managed policy':'failure') : undefined;
    const query={async toggleMcpServer(){if(failure)throw failure;}};
    const session={query,sdkMcpServers:rows}; let polls=0;
    const host={getSession:()=>session,controlRequestsWait:()=>false,refreshSdkMcpStatuses:async()=>{
      if (++polls===1) return rows;
      if (scenario==='error-unconfirmed') return undefined;
      return [{...rows[0],status:scenario==='disabled'||scenario==='error-policy'?'disabled':'connected'}];
    }};
    const native=factory(host,session);native.retireHeldMcpVerb=()=>{};
    const expected=JSON.parse(JSON.stringify(await native.mcpEnableServer('s','server')));
    const f=setup();f.setRows(rows); f.deps.formatError=e=>e instanceof Error?e.message:String(e);
    let count=0;f.deps.refreshStatus=async(_id,token)=>{if(++count===1)return {actorToken:token,servers:rows}; if(scenario==='error-unconfirmed')return undefined;return {actorToken:token,servers:[{...rows[0],status:scenario==='disabled'||scenario==='error-policy'?'disabled':'connected'}]};};
    f.deps.toggle=async(_id,token)=>{if(failure)throw failure;return {actorToken:token};};
    assert.deepEqual(await f.verbs.mcpEnableServer('s','server'),expected,scenario);
  }
  const f=setup();f.setBinding('none');
  assert.deepEqual(await f.verbs.mcpRetryConnection('s','server'),{});
  assert.deepEqual(f.calls,['reconnect','status']);
  const unknown=setup();unknown.deps.getAuthBinding=()=>undefined;
  assert.match((await unknown.verbs.mcpRetryConnection('s','server')).error,/verify/);
  const stale=setup();stale.setBinding('none'); stale.deps.controlRequestsWait=()=>{stale.invalidateBinding();return false;};
  assert.match((await stale.verbs.mcpRetryConnection('s','server')).error,/verify/);
  assert.deepEqual(stale.calls,[]);
});


test('unbound retry native VM dial and same-server in-flight behavior', async () => {
  const source=fs.readFileSync(path.resolve('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js'),'utf8');
  const method=source.slice(source.indexOf('async mcpRetryConnection('),source.indexOf('async mcpClearAuth('));
  const nativeFactory=vm.runInNewContext(`(deps)=>({deps,mcpRetryInFlight:new Map(),foundGoneOf:()=>new Set(),book:()=>undefined,retireHeldMcpVerb(){},${method}})`, {
    RA:60000,Date,Error,setTimeout,clearTimeout,fx:(_s,_q,p)=>p,oj:(id,name)=>`${id}\0${name}`,
    t:{L5:{warn(){},info(){},error(){}},M4:s=>s,cz(){}} });
  let d=deferred(), calls=[];
  const rows=[{name:'server',status:'failed'}], query={reconnectMcpServer:()=>{calls.push('reconnect');return d.promise;}};
  const session={query,sdkMcpServers:rows};
  const native=nativeFactory({getSession:()=>session,controlRequestsWait:()=>false,redialing(){},refreshSdkMcpStatuses:async()=>{calls.push('status');return [{name:'server',status:'connected'}];}});
  const first=native.mcpRetryConnection('s','server');
  const concurrent=await native.mcpRetryConnection('s','server');
  d.resolve();const nativeResult=await first;
  assert.deepEqual(JSON.parse(JSON.stringify(concurrent)),{error:'Already reconnecting'});
  assert.deepEqual(JSON.parse(JSON.stringify(nativeResult)),{});assert.deepEqual(calls,['reconnect','status']);
  const f=setup();f.setBinding('none');d=deferred();const started=deferred();
  f.deps.reconnect=async(_id,token)=>{f.calls.push('reconnect');started.resolve();await d.promise;return {actorToken:token};};
  f.deps.refreshStatus=async(_id,token)=>{f.calls.push('status');return {actorToken:token,servers:[{name:'server',status:'connected'}]};};
  const local=f.verbs.mcpRetryConnection('s','server');await started.promise;
  assert.deepEqual(await f.verbs.mcpRetryConnection('s','server'),{error:'Already reconnecting'});
  d.resolve();assert.deepEqual(await local,{});assert.deepEqual(f.calls,['reconnect','status']);
});
