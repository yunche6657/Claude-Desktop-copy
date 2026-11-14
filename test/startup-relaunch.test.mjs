import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {applyStartupDefaults,clearStartupDefaultsForRelaunch}=require('../desktop/startup-defaults.cjs');
const profile=n=>({baseUrl:'http://127.0.0.1/'+n,apiKey:'dummy-'+n,model:'model-'+n});
test('launcher-derived routing is removed before a restarted process reads the new profile',()=>{
 const env={}; applyStartupDefaults(env,()=>profile('a'));
 const child={...env}; applyStartupDefaults(child,()=>profile('a'));
 assert.equal(child.ANTHROPIC_AUTH_TOKEN,'dummy-a');
 assert.ok(!child.CLAUDE_REPLICA_DERIVED_DEFAULTS.includes('dummy-a'));
 clearStartupDefaultsForRelaunch(child); applyStartupDefaults(child,()=>profile('b'));
 assert.equal(child.ANTHROPIC_BASE_URL,profile('b').baseUrl);
 assert.equal(child.ANTHROPIC_AUTH_TOKEN,'dummy-b');assert.equal(child.CLAUDE_AGENT_MODEL,'model-b');
});
test('explicit caller routing and values changed after startup survive relaunch cleanup',()=>{
 const env={ANTHROPIC_API_KEY:'explicit',ANTHROPIC_BASE_URL:'http://127.0.0.1/custom',CLAUDE_AGENT_MODEL:'explicit-model'};
 applyStartupDefaults(env,()=>profile('a'));clearStartupDefaultsForRelaunch(env);
 assert.equal(env.ANTHROPIC_API_KEY,'explicit');assert.equal(env.CLAUDE_AGENT_MODEL,'explicit-model');
 const derived={};applyStartupDefaults(derived,()=>profile('a'));derived.ANTHROPIC_AUTH_TOKEN='changed';
 clearStartupDefaultsForRelaunch(derived);assert.equal(derived.ANTHROPIC_AUTH_TOKEN,'changed');
});
