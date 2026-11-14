import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createGrowthBookProvider}=require('../desktop/growthbook-provider.cjs');
const {createNotificationPolicy}=require('../desktop/notification-policy.cjs');

test('notification gate follows feature on, not the truthiness of its value',async()=>{
 const features={'879583975':{on:false,value:'truthy'},other:{on:true,value:false}};
 const provider=createGrowthBookProvider({getContext:()=>({mode:'3p',source:{kind:'static',identity:'fixture',features}})});
 try {await provider.init();assert.equal(provider.getFeatureValue('879583975',false),'truthy');assert.equal(provider.getFeatureOn('879583975',true),false);
  assert.equal(provider.getFeatureOn('other',false),true);assert.equal(provider.getFeatureOn('missing',false),false);
  const policy=createNotificationPolicy({getPreferences:()=>({}),getFeatureValue:provider.getFeatureOn});assert.deepEqual(policy.getSignals('idle'),{banner:true,badge:false});
 } finally {provider.dispose()}
});
