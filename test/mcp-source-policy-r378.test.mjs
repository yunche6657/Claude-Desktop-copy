import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { rowsFromElsewhere, decideLocalMcp } = require('../desktop/mcp-source-policy.cjs');

test('source projection matches fixed KV with its predicate results supplied by owner', () => {
  const text = fs.readFileSync(path.resolve('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js'), 'utf8');
  const start = text.indexOf('function KV('), end = text.indexOf('var qV=', start);
  assert.ok(start >= 0 && end > start);
  const native = vm.runInNewContext(`(()=>{${text.slice(start,end)}; return KV})()`, {
    t: { wT: e => e.remoteRows, W: e => e.remoteControl, q2: e => e?.foreignImport === true }
  });
  for (const backendKind of ['local','wsl','ssh']) for (const remoteRows of [false,true])
    for (const remoteControl of [false,true]) for (const foreignImport of [false,true])
      for (const hasImport of [false,true]) for (const resumeConfirmed of [false,true]) {
        if (foreignImport && !hasImport) continue;
        const source = { backendKind, remoteRows, remoteControl, foreignImport, hasImport, resumeConfirmed };
        const original = { backend: {kind:backendKind}, remoteRows, remoteControl, foreignImport,
          importedFrom: hasImport || foreignImport ? {foreignImport} : undefined, resumeConfirmed };
        assert.equal(rowsFromElsewhere(source), native(original), JSON.stringify(source));
      }
  assert.equal(rowsFromElsewhere(), true);
  assert.equal(rowsFromElsewhere({backendKind:'local'}), true);
});

test('CLI routing, unknown provenance, reserved and disabled tools fail closed', () => {
  const source = {backendKind:'local',remoteRows:false,remoteControl:false,foreignImport:false,hasImport:false,resumeConfirmed:false};
  const session = {cliMcpAppServerNames:[], enabledMcpTools:{}};
  const base = {source, session, server:'example', operation:'callTool', tool:'write', reserved:false, globalToolDisabled:false};
  assert.equal(decideLocalMcp(base), 'local');
  assert.equal(decideLocalMcp({...base, source:undefined}), 'deny');
  assert.equal(decideLocalMcp({...base, reserved:undefined}), 'deny');
  assert.equal(decideLocalMcp({...base, globalToolDisabled:undefined}), 'deny');
  assert.equal(decideLocalMcp({...base, session:{...session,enabledMcpTools:{'local:example:write':false}}}), 'deny');
  assert.equal(decideLocalMcp({...base, session:{...session,cliMcpAppServerNames:['example']}}), 'deny');
  assert.equal(decideLocalMcp({...base, operation:'readResource', session:{...session,cliMcpAppServerNames:['example']}}), 'cli-read');
  assert.equal(decideLocalMcp({...base, operation:'listResources', session:{...session,cliMcpAppServerNames:['example']}}), 'deny');
});


test('fixed source predicates and KV execute together against native-shaped records', () => {
  const lza = fs.readFileSync(path.resolve('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js'), 'utf8');
  const bn = fs.readFileSync(path.resolve('../ccd-ref/asar/.vite/build/index.chunk-Bn6onBlX.js'), 'utf8');
  const extract = (source, begin, end) => {
    const i = source.indexOf(begin), j = source.indexOf(end, i);
    assert.ok(i >= 0 && j > i, begin);
    return source.slice(i,j);
  };
  const native = vm.runInNewContext(`(()=>{
    ${extract(lza,'function $Cr(', 'function ewr(')}
    ${extract(lza,'function epr(', 'function tpr(')}
    ${extract(lza,'function FQa(', 'function IQa(')}
    ${extract(lza,'function WJe(', 'var GJe=')}
    const t={wT:$Cr,W:FQa,q2:WJe};
    ${extract(bn,'function KV(', 'var qV=')}
    return KV;
  })()`);
  const { nativeRowsFromElsewhere } = require('../desktop/mcp-source-policy.cjs');
  assert.equal(nativeRowsFromElsewhere(undefined), native(undefined));
  for (const kind of ['local','wsl','ssh']) for (const remoteTarget of [undefined,{}])
    for (const flag of [null,'_startedThroughHostCliLauncher','_everStartedThroughHostCliLauncher','launcherMarked'])
      for (const importedFrom of [undefined,'local-1p-fixture','remote-elsewhere','previous-profile-fixture'])
        for (const resumeConfirmed of [false,true]) {
          const record = {backend:{kind,remoteTarget}, importedFrom, resumeConfirmed, ...(flag ? {[flag]:true} : {})};
          assert.equal(nativeRowsFromElsewhere(record), native(record));
        }
});

test('kernel session lease expires when the transcript is replaced', t => {
  const { createSessionKernel } = require('../desktop/session-kernel.cjs');
  const kernel = createSessionKernel({emit(){}, createAgent:()=>({})});
  t.after(() => kernel.dispose());
  kernel.start({sessionId:'local_source_lease_fixture'});
  const lease = kernel.getSessionLease('local_source_lease_fixture');
  assert.equal(lease.isCurrent(), true);
  kernel.setTranscript('local_source_lease_fixture', [{message:{role:'user',content:'synthetic replacement'}}]);
  assert.equal(lease.isCurrent(), false);
});

