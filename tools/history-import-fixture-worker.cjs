'use strict';
// Invoked only by the isolated integration test.
const {createFixtureHistoryImportHost}=require('../desktop/history-import-fixture-host.cjs');
const [root,mode]=process.argv.slice(2);
const identity={accountId:'account-a',orgId:'org-a',generation:'1'};
const host=createFixtureHistoryImportHost({root,identity,afterCommit:mode==='crash'?()=>process.exit(42):undefined});
(async()=>{
 let result;
 if(mode==='inspect') result=await host.inspect();
 else if(mode==='stale') {const [entry]=await host.scan();identity.generation='2';result=await host.importSource(entry.sourceToken);}
 else if(mode==='import'||mode==='crash'){const [entry]=await host.scan();result=entry?await host.importSource(entry.sourceToken):{status:'none'};}
 else throw Error('Unknown operation');
 process.stdout.write(JSON.stringify(result));
})().catch(e=>{process.stderr.write(e.stack);process.exitCode=1;});
