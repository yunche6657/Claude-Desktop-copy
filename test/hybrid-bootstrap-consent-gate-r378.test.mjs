import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createHybridBootstrapConsentGate}=require('../desktop/hybrid-bootstrap-consent-gate.cjs'),{createBootstrapConsentStore}=require('../desktop/hybrid-bootstrap-consent-store.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise}},tick=()=>new Promise(r=>setImmediate(r));
function setup(){let config={targets:[{label:'script',value:'first',key:'script'}]},source='a',saved={},count=0,dialog=deferred();const ledger=createBootstrapConsentStore({store:{get:()=>saved,set:(_k,v)=>{saved=v;count++}}});const gate=createHybridBootstrapConsentGate({getTargets:c=>c.targets,ledger,onDeclined:()=>{},manager:{ask:()=>dialog.promise},getSourceIdentity:()=>source,getCurrentConfig:()=>config});return {gate,check:()=>gate.check(config),dialog,config:v=>config=v,source:v=>source=v,writes:()=>count,saved:()=>saved};}
test('explicit allow writes ledger before re-resolve',async()=>{const x=setup();let resumed=0;const result=x.check();assert.equal(result.status,'pending');result.prompt(()=>{assert.equal(x.writes(),1);resumed++});await tick();x.dialog.resolve('allow');await tick();assert.equal(resumed,1);assert.equal(x.check().status,'consented');});
test('cancel and storage error never authorize or resume',async()=>{for(const choice of ['cancel','error']){const x=setup();let resumed=0;x.check().prompt(()=>resumed++);await tick();x.dialog.resolve(choice);await tick();assert.equal(resumed,0);assert.equal(x.writes(),0);assert.equal(x.check().status,'pending');}const dialog=deferred();let resumed=0;const g=createHybridBootstrapConsentGate({getTargets:c=>c.targets,ledger:{readConsents:()=>({}),recordAllowed:()=>{throw Error('disk')}},onDeclined:()=>{},manager:{ask:()=>dialog.promise},getSourceIdentity:()=>1,getCurrentConfig:()=>({targets:[{label:'a',value:'x'}]})});g.check({targets:[{label:'a',value:'x'}]}).prompt(()=>resumed++);await tick();dialog.resolve('allow');await tick();assert.equal(resumed,0);});
test('old approval cannot authorize changed source or target',async()=>{for(const change of ['source','target']){const x=setup();let resumed=0;x.check().prompt(()=>resumed++);await tick();if(change==='source')x.source('b');else x.config({targets:[{label:'script',value:'different',key:'script'}]});x.dialog.resolve('allow');await tick();assert.equal(x.writes(),0);assert.equal(resumed,0);assert.equal(x.check().status,'pending');}});
test('trusted delivery bypass and repeated prompt do not manufacture approval',async()=>{const x=setup();assert.equal(x.gate.check({targets:[]},{trustedDelivery:true}).status,'consented');let resumed=0;const p=x.check();p.prompt(()=>resumed++);p.prompt(()=>resumed++);await tick();x.dialog.resolve('allow');await tick();assert.equal(x.writes(),1);assert.equal(resumed,1);});

test('same target in a different source reuses native global ledger',async()=>{const x=setup();x.check().prompt(()=>{});await tick();x.dialog.resolve('allow');await tick();assert.equal(x.check().status,'consented');x.source('b');assert.equal(x.check().status,'consented');});

test('cancel and prompt rejection trigger injected decline without ledger writes',async()=>{for(const outcome of ['cancel','error','throw']){let declines=[],writes=0;const g=createHybridBootstrapConsentGate({getTargets:c=>c.targets,ledger:{readConsents:()=>({}),recordAllowed:()=>writes++},manager:{ask:async()=>{if(outcome==='throw')throw Error('failed');return outcome}},onDeclined:choice=>declines.push(choice),getSourceIdentity:()=>1,getCurrentConfig:()=>({targets:[{label:'a',value:'x'}]})});g.check({targets:[{label:'a',value:'x'}]}).prompt(()=>{throw Error('must not continue')});await tick();assert.deepEqual(declines,[outcome==='throw'?'error':outcome]);assert.equal(writes,0);}});

test('new candidate waits for stale prompt, then receives its own approval',async()=>{
 let config={targets:[{label:'a',value:'old'}]},oldCurrent=true,saved={},resumed=[],asks=[];
 const dialogs=[deferred(),deferred()];
 const ledger=createBootstrapConsentStore({store:{get:()=>saved,set:(_k,v)=>saved=v}});
 const gate=createHybridBootstrapConsentGate({getTargets:c=>c.targets,ledger,manager:{ask:request=>{asks.push(request);return dialogs[asks.length-1].promise}},onDeclined:()=>{},getSourceIdentity:()=>1,getCurrentConfig:()=>config});
 gate.check(config,{isCurrent:()=>oldCurrent}).prompt(()=>resumed.push('old'));await tick();
 oldCurrent=false;config={targets:[{label:'a',value:'new'}]};
 gate.check(config).prompt(()=>resumed.push('new'));await tick();assert.equal(asks.length,1);
 dialogs[0].resolve('allow');await tick();assert.equal(asks.length,2);assert.equal(asks[1].targets[0].detail,'new');assert.deepEqual(saved,{});
 dialogs[1].resolve('allow');await tick();assert.deepEqual(resumed,['new']);assert.equal(gate.check(config).status,'consented');
});

test('queued current request reuses a global consent recorded by the first prompt',async()=>{
 const x=setup();let resumed=[];
 x.check().prompt(()=>resumed.push('first'));await tick();
 x.check().prompt(()=>resumed.push('second'));x.dialog.resolve('allow');await tick();
 assert.deepEqual(resumed,['first','second']);assert.equal(x.writes(),1);
});

test('full latest candidate snapshot governs approval including newly added targets',async()=>{
 for(const change of ['add','remove','change']){
  const x=setup();let resumed=0;x.check().prompt(()=>resumed++);await tick();
  if(change==='add')x.config({targets:[{label:'script',value:'first',key:'script'},{label:'extra',value:'new'}]});
  if(change==='remove')x.config({targets:[]});
  if(change==='change')x.config({targets:[{label:'script',value:'changed',key:'script'}]});
  x.dialog.resolve('allow');await tick();assert.equal(x.writes(),0,change);assert.equal(resumed,0,change);
 }
});

test('asynchronous ledger honors current guard at its commit boundary',async()=>{
 let config={targets:[{label:'a',value:'old'}]},writes=0,resumed=0;const writing=deferred();
 const gate=createHybridBootstrapConsentGate({getTargets:c=>c.targets,ledger:{readConsents:()=>({}),recordAllowed:async(_targets,{isCurrent})=>{await writing.promise;if(isCurrent())writes++}},manager:{ask:async()=>'allow'},onDeclined:()=>{},getSourceIdentity:()=>1,getCurrentConfig:()=>config});
 gate.check(config).prompt(()=>resumed++);await tick();config={targets:[{label:'a',value:'new'}]};writing.resolve();await tick();
 assert.equal(writes,0);assert.equal(resumed,0);
});

test('a ledger that does not persist consent cannot resume',async()=>{
 let resumed=0;const config={targets:[{label:'a',value:'x'}]};
 const gate=createHybridBootstrapConsentGate({getTargets:c=>c.targets,ledger:{readConsents:()=>({}),recordAllowed:async()=>{}},manager:{ask:async()=>'allow'},onDeclined:()=>{},getSourceIdentity:()=>1,getCurrentConfig:()=>config});
 gate.check(config).prompt(()=>resumed++);await tick();assert.equal(resumed,0);
});

test('native p/o/s global ledger and declined behavior via extracted VM',async()=>{const {readFileSync}=await import('node:fs'),vm=(await import('node:vm')).default,{createHash}=await import('node:crypto');const source=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-xoZNrP6a.js',import.meta.url),'utf8');const o=source.slice(source.indexOf('function o(e)'),source.indexOf('var c={status:'));const p=source.slice(source.indexOf('function p(t,n,r)'),source.indexOf('exports.checkBootstrapConsent='));let store={},choice='allowed',exits=0,done=0;const sandbox={a:()=>({get:()=>store,set:(_k,v)=>store=v}),n:'consented',r:value=>createHash('sha256').update(value).digest('base64'),l:'idle',d:t=>t.label,e:{L5:{info(){},warn(){}},FY:{},$R:()=>exits++},require:file=>file.includes('JnLh')?{r:{showConsentWindow:async()=>choice}}:{rz:{logEvent:async()=>{}}}};vm.createContext(sandbox);vm.runInContext(`${o};${p}`,sandbox);const rows=[{label:'a',value:'x',key:'a'}];sandbox.p(rows,()=>done++,false);await tick();await tick();assert.equal(done,1);assert.equal(sandbox.o(rows).length,0);choice='cancelled';sandbox.p([{label:'b',value:'y',key:'b'}],()=>done++,false);await tick();await tick();assert.equal(exits,1);assert.equal(done,1);});
