import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {derivePreviewPolicy,createPreviewOriginPolicy,buildBuiltinBrowserHostPolicy,hostPolicyVerdict,parseHostPattern}=require('../desktop/preview-origin-policy.cjs');

test('native managed browser policies are available when absent and only recognized managed disabling values take effect',()=>{
 const absent=derivePreviewPolicy({managedConfig:{deploymentMode:'3p'},builtinBrowserEnabled:true});assert.equal(absent.available,true);assert.equal(absent.externalBrowsingDisabled,false);assert.equal(absent.externalNavigationDisabled,false);assert.equal(absent.userToolsEnabled,true);assert.equal(absent.browserFeatureEnabled,true);
 const disabled=derivePreviewPolicy({builtinBrowserEnabled:true,managedSettings:{browserExternalPageTools:'DISABLE'}});assert.equal(disabled.externalBrowsingDisabled,true);assert.equal(disabled.browserFeatureEnabled,true);
 const nav=derivePreviewPolicy({builtinBrowserEnabled:true,managedSettings:{disableBrowserExternalNavigation:true}});assert.equal(nav.externalNavigationDisabled,true);assert.equal(nav.browserFeatureEnabled,false);
 const invalid=derivePreviewPolicy({builtinBrowserEnabled:true,managedSettings:{browserExternalPageTools:true,disableBrowserExternalNavigation:'true'}});assert.equal(invalid.externalBrowsingDisabled,false);assert.equal(invalid.externalNavigationDisabled,false);
 assert.equal(derivePreviewPolicy({managedStatus:'unavailable',builtinBrowserEnabled:true}).available,false);
});

test('3p browser gate follows actual builtinBrowser config and omitted user preference defaults on independently',()=>{
 assert.equal(derivePreviewPolicy({managedConfig:{deploymentMode:'3p'}}).browserFeatureEnabled,false);
 assert.equal(derivePreviewPolicy({managedConfig:{deploymentMode:'3p',builtinBrowserEnabled:true}}).browserFeatureEnabled,true);
 assert.equal(derivePreviewPolicy({builtinBrowserEnabled:true,preferences:{coworkBrowserToolsEnabled:false}}).browserFeatureEnabled,false);
 assert.equal(derivePreviewPolicy({builtinBrowserEnabled:true,pendingServed:true}).browserFeatureEnabled,false);
 assert.equal(derivePreviewPolicy({builtinBrowserEnabled:true,admissionBlocked:true}).browserFeatureEnabled,false);
 assert.equal(derivePreviewPolicy({builtinBrowserEnabled:true,featureGates:{17519066:{on:false}}}).browserFeatureEnabled,false);
 assert.equal(derivePreviewPolicy({managedConfig:{deploymentMode:'consumer'},featureGates:{17519066:{on:true}}}).browserFeatureEnabled,true);
});

test('native loopback URL spellings classify locally without hosted check or arbitrary global allow',async()=>{
 const service=createPreviewOriginPolicy({getInterfaceAddresses:()=>[]});
 for(const url of ['http://localhost:4444/','http://app.localhost/','http://localhost./','http://127.1/','http://127.3.4.5/','http://0.0.0.0/','http://[::1]/','http://[::]/','http://[::ffff:127.0.0.1]/'])assert.deepEqual(await service.classifyOrigin(url),{kind:'ok',category:'category0'});
 assert.deepEqual(await service.classifyOrigin('https://example.com/'),{kind:'error',reason:'hosted_site_check_required'});
 service.dispose();assert.deepEqual(await service.classifyOrigin('http://localhost/'),{kind:'error',reason:'disposed'});
});

test('static native metadata and private-address floors handle mapped aliases without network access',async()=>{
 const service=createPreviewOriginPolicy({getInterfaceAddresses:()=>[]});
 for(const url of ['http://169.254.169.254/','http://metadata.google.internal/','http://100.100.100.200/','http://[::ffff:169.254.169.254]/'])assert.deepEqual(await service.classifyOrigin(url),{kind:'ok',category:'category1'});
 for(const url of ['http://10.1.2.3/','http://192.168.1.2/','http://[fd00::1]/','http://[::ffff:10.0.0.1]/','http://printer.local/','http://example.invalid/'])assert.deepEqual(await service.classifyOrigin(url),{kind:'ok',category:'category3',privateNetworkOnly:true});
 assert.equal((await service.classifyOrigin('http://8.8.8.8/')).kind,'error');
});

test('native host policy honors exact ports, public-suffix guarded wildcards, egress intersection and localhost carve-out',async()=>{
 assert.deepEqual(parseHostPattern('*.example.com:8443'),{host:'*.example.com',port:8443});assert.equal(parseHostPattern('https://example.com'),null);assert.equal(parseHostPattern('[::1]'),null);
 const block=buildBuiltinBrowserHostPolicy({enabled:true,defaultDomainPolicy:'block',allowedDomains:['*.com','*.example.com:8443']});
 assert.equal(hostPolicyVerdict(block,'https://x.example.com:8443/'),'allow');assert.equal(hostPolicyVerdict(block,'https://x.example.com:443/'),'block');assert.equal(hostPolicyVerdict(block,'https://unrelated.com/'),'block');
 const egress=buildBuiltinBrowserHostPolicy({enabled:true,egress:[['*.example.com'],['x.example.com:443']]});assert.equal(hostPolicyVerdict(egress,'https://x.example.com/'),null);assert.equal(hostPolicyVerdict(egress,'https://y.example.com/'),'block');
 const local=createPreviewOriginPolicy({getInterfaceAddresses:()=>[],getHostPolicy:()=>block});assert.deepEqual(await local.classifyOrigin('http://127.0.0.1:4321/'),{kind:'ok',category:'category0'});assert.deepEqual(await local.classifyOrigin('http://192.168.1.2/'),{kind:'ok',category:'category_org_blocked'});
});

test('public classification requires an explicit hosted provider and policy invalidation withholds stale checks',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);const service=createPreviewOriginPolicy({getInterfaceAddresses:()=>[],hostedSiteCheck:()=>pending});const request=service.classifyOrigin('https://example.com/');await new Promise(resolve=>setImmediate(resolve));service.invalidate();release({category:'category0'});assert.deepEqual(await request,{kind:'epoch-changed'});
 const signed=createPreviewOriginPolicy({authenticatesHostedSiteCheck:true,getInterfaceAddresses:()=>[],hostedSiteCheck:async()=>({category:'category2'})});assert.deepEqual(await signed.classifyOrigin('http://printer.local/'),{kind:'ok',category:'category2'});
 const own=createPreviewOriginPolicy({getInterfaceAddresses:()=>['8.8.8.8']});assert.deepEqual(await own.classifyOrigin('http://8.8.8.8/'),{kind:'ok',category:'category3',privateNetworkOnly:true});
});


test('base cM and Cowork dM retain separate feature gates without inferring base denial from a Cowork failure',()=>{
 const baseOnly=derivePreviewPolicy({builtinBrowserEnabled:true,featureGates:{17519066:{on:true},3990395613:{on:false}}});assert.equal(baseOnly.browserFeatureEnabled,true);assert.equal(baseOnly.coworkBrowserEnabled,false);assert.equal(baseOnly.coworkBrowserAvailable,false);
 const defaults=derivePreviewPolicy({builtinBrowserEnabled:true});assert.equal(defaults.browserFeatureEnabled,true);assert.equal(defaults.coworkBrowserEnabled,true);
 const userDisabled=derivePreviewPolicy({builtinBrowserEnabled:true,preferences:{coworkBrowserToolsEnabled:false}});assert.equal(userDisabled.coworkBrowserAvailable,true);assert.equal(userDisabled.coworkBrowserEnabled,false);
});
