import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {buildTraversal,buildFieldCollector,inspectSource,probeSchemaClosure,probePcClosure,probeObjectConstructor,probeZodObjectClosure,buildShippedZodSubset,buildShippedBuiltinBrowserSchema,buildShippedTelemetrySchema,buildShippedFeatureDiscoverySchema,buildShippedAppearanceSchema,buildShippedGatewayPartialSchema,buildShippedGatewayCredentialPartialSchema,buildShippedAnthropicPartialSchema,buildShippedMantlePartialSchema,buildShippedBedrockPartialSchema,buildShippedFoundryPartialSchema,buildShippedVertexPartialSchema,buildShippedInferencePartialSchema,buildShippedBootstrapPartialSchema,buildShippedSelfHostedPartialSchema,buildShippedLimitsAndDictationSchemas,buildShippedEntraSchema,buildShippedFieldCollector}=require('../tools/inspect-bootstrap-registry.cjs');
const source=readFileSync(resolve('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js'),'utf8');
test('original consent traversal visits nested object, union and array metadata',()=>{
 const walk=buildTraversal(source), field=(meta)=>({type:'string',meta}), obj=shape=>({type:'object',shape});
 const schema=obj({
  command:field({remotePolicy:{requiresUserConsent:true}}),
  nested:obj({safe:field({}),secret:field({remotePolicy:{requiresUserConsent:true}})}),
  choices:{type:'union',options:[obj({one:field({remotePolicy:{requiresUserConsent:true}})}),obj({two:field({remotePolicy:{requiresUserConsent:true}})})]},
  list:{type:'array',element:obj({script:field({remotePolicy:{requiresUserConsent:true}})})},
 });
 assert.deepEqual([...walk(schema)].sort(),['choices.one','choices.two','command','list.script','nested.secret']);
});
test('inspection labels registry incomplete and checks shipped export anchors',()=>{
 const report=inspectSource(source);assert.equal(report.completeness,'partial');
 assert.ok(Object.values(report.exportEvidence).every(Boolean));assert.equal(report.sourceAnchors.traversal,true);assert.equal(report.sourceAnchors.targets,true);assert.ok(report.unresolved.length>=3);
 assert.throws(()=>buildTraversal('missing'),/anchor not found/);
});

test('actual flat schema initializer exposes its missing closure dependency without fake substitution',()=>{
 const result=probeSchemaClosure(source);assert.equal(result.initialized,false);assert.equal(result.errorName,'ReferenceError');assert.equal(result.missing,'HPe');
 const r=inspectSource(source);assert.ok(r.offsets.zodObject>0&&r.offsets.objectConstructor>0&&r.offsets.schemaPc>r.offsets.zodObject&&r.offsets.fieldCollector>r.offsets.schemaPc&&r.offsets.flatSchema>r.offsets.fieldCollector);
});

test('extracted VPe collects field metadata with union provider context',()=>{
 const collect=buildFieldCollector(source), field=key=>({type:'string',fieldMeta:{flatKey:key}}),lit=value=>({type:'literal',literal:value}),object=shape=>({type:'object',shape});
 const root=object({plain:field('flatPlain'),inference:{type:'union',options:[object({provider:lit('gateway'),credential:object({kind:lit('static'),token:field('credential')})}),object({provider:lit('gateway'),credential:object({kind:lit('interactive'),token:field('credential')})})]}});
 const entries=collect(root);assert.deepEqual([...entries.keys()],['flatPlain','credential']);
 assert.deepEqual(Array.from(entries.get('credential').path),['inference','credential','token']);
 assert.deepEqual(Array.from(entries.get('credential').armContext.providers),['gateway']);
 assert.deepEqual(Array.from(entries.get('credential').armContext.credentialKinds),['static','interactive']);
});
test('actual Pc expression reveals constructor dependency without loading main',()=>{const r=probePcClosure(source);assert.equal(r.initialized,false);assert.equal(r.errorName,'ReferenceError');assert.equal(r.missing,'j')});

test('original j and lt expose the object constructor contract with recording nse',()=>{
 const j=probeObjectConstructor(source);const shape={field:1};const made=j(shape,{message:'bad'});
 assert.equal(made.def.type,'object');assert.equal(made.def.shape,shape);assert.equal(made.def.error(),'bad');
 assert.throws(()=>j(shape,{message:'bad',error:'other'}),/Cannot specify both/);
});
test('actual ZodObject initialization cannot run without original Xt closure',()=>{
 const r=probeZodObjectClosure(source);assert.equal(r.initialized,false);assert.equal(r.errorName,'ReferenceError');assert.equal(r.missing,'Xt');
});

test('actual contiguous shipped Zod runtime constructs and validates object fields in isolated VM',()=>{
 const z=buildShippedZodSubset(source);
 const schema=z.j({title:z.D(),enabled:z.k(),mode:z.Rn(['allow','block']),sites:z.A(z.D())});
 assert.deepEqual(Object.keys(schema.shape),['title','enabled','mode','sites']);
 assert.equal(schema.safeParse({title:'test',enabled:true,mode:'block',sites:['example.com']}).success,true);
 assert.equal(schema.safeParse({title:3,enabled:true,mode:'block',sites:[]}).success,false);
 assert.equal(schema.safeParse({title:'ok',enabled:true,mode:'other',sites:[]}).success,false);
 assert.throws(()=>buildShippedZodSubset('missing'),/anchor not found/);
});

test('actual builtinBrowser cluster and real Zod metadata build in isolated VM',()=>{
 const schema=buildShippedBuiltinBrowserSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['enabled','defaultDomainPolicy','allowedDomains','blockedDomains']);
 const actual=Object.fromEntries(Object.entries(shape).map(([key,node])=>[key,node.__antFieldMeta.flatKey]));
 assert.deepEqual(actual,{enabled:'builtinBrowserEnabled',defaultDomainPolicy:'builtinBrowserDefaultDomainPolicy',allowedDomains:'builtinBrowserAllowedDomains',blockedDomains:'builtinBrowserBlockedDomains'});
 assert.equal(shape.defaultDomainPolicy.__antFieldMeta.failClosedValue,'block');
 assert.deepEqual(Array.from(shape.allowedDomains.__antFieldMeta.failClosedValue),[]);
 assert.deepEqual(Array.from(shape.blockedDomains.__antFieldMeta.failClosedValue),['*']);
 const result=schema.safeParse({enabled:true,defaultDomainPolicy:'block',allowedDomains:['*','example.com'],blockedDomains:['*']});
 assert.equal(result.success,true);assert.deepEqual(Array.from(result.data.allowedDomains),['example.com']);
 assert.equal(schema.safeParse({enabled:true,defaultDomainPolicy:'bad'}).success,false);
});

test('actual telemetry cluster builds with shipped Zod and original field metadata',()=>{
 const schema=buildShippedTelemetrySchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['orgUuid','disableEssential','disableNonessential','disableNonessentialServices','usageMetrics']);
 assert.deepEqual(Object.fromEntries(Object.entries(shape).map(([k,v])=>[k,v.__antFieldMeta.flatKey])),{orgUuid:'deploymentOrganizationUuid',disableEssential:'disableEssentialTelemetry',disableNonessential:'disableNonessentialTelemetry',disableNonessentialServices:'disableNonessentialServices',usageMetrics:'usageMetricsEnabled'});
 assert.equal(shape.disableEssential.__antFieldMeta.failClosedValue,true);assert.equal(shape.disableNonessential.__antFieldMeta.failClosedValue,true);assert.equal(shape.disableNonessentialServices.__antFieldMeta.failClosedValue,true);
 assert.equal(shape.usageMetrics.__antFieldMeta.remotePolicy.hybrid.scope,'only');
 assert.equal(schema.safeParse({orgUuid:'not-a-uuid',disableEssential:true,usageMetrics:false}).success,true);
 assert.equal(schema.safeParse({orgUuid:123}).success,false);assert.equal(schema.safeParse({disableEssential:'true'}).success,false);
});

test('actual featureDiscovery schema and metadata use shipped Zod',()=>{
 const schema=buildShippedFeatureDiscoverySchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['disabled']);
 const meta=shape.disabled.__antFieldMeta;assert.equal(meta.flatKey,'disableFeatureDiscovery');assert.equal(meta.failClosedValue,true);assert.equal(meta.remotePolicy.hotApplied,true);assert.deepEqual(Array.from(meta.support.enabled.scopes),['3p']);
 assert.equal(schema.safeParse({disabled:true}).success,true);assert.equal(schema.safeParse({disabled:'true'}).success,false);assert.equal(schema.safeParse({}).success,true);
});

test('actual appearance schema validates trimmed names using shipped Zod',()=>{
 const schema=buildShippedAppearanceSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['deploymentDisplayName','deploymentDisplaySubtitle','disableConfigDeprecationWarnings']);
 assert.equal(shape.deploymentDisplayName.__antFieldMeta.flatKey,'deploymentDisplayName');
 assert.equal(shape.deploymentDisplayName.__antFieldMeta.remotePolicy.hybrid.derived,true);
 assert.equal(shape.deploymentDisplaySubtitle.__antFieldMeta.remotePolicy.hybrid.scope,'excluded');
 const accepted=schema.safeParse({deploymentDisplayName:'  Acme  ',disableConfigDeprecationWarnings:false});
 assert.equal(accepted.success,true);assert.equal(accepted.data.deploymentDisplayName,'Acme');
 assert.equal(schema.safeParse({deploymentDisplayName:' '.repeat(5)}).success,false);
 assert.equal(schema.safeParse({deploymentDisplaySubtitle:'x'.repeat(61)}).success,false);
 assert.equal(schema.safeParse({disableConfigDeprecationWarnings:'true'}).success,false);
});

test('gateway DAe direct fields run with shipped Zod and original URL guards',()=>{
 const schema=buildShippedGatewayPartialSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['provider','baseUrl','streamIdleTimeoutSec','gatewayManagedClaudeCode','customHeaders','sessionLifetimeSec','credential']);
 const meta=shape.baseUrl.__antFieldMeta;assert.equal(meta.flatKey,'inferenceGatewayBaseUrl');assert.equal(meta.remotePolicy.requiresUserConsent,true);assert.equal(meta.remotePolicy.rejectLoopback,true);assert.equal(meta.remotePolicy.originPinned.carries,'server-issued-credential');
 const good=schema.safeParse({provider:'gateway',baseUrl:'gateway.example.com',streamIdleTimeoutSec:300});assert.equal(good.success,true);assert.equal(good.data.baseUrl,'https://gateway.example.com');
 assert.equal(schema.safeParse({provider:'gateway',baseUrl:'ftp://gateway.example.com'}).success,false);
 assert.equal(schema.safeParse({provider:'gateway',baseUrl:'https://u:p@gateway.example.com'}).success,false);
 assert.equal(schema.safeParse({provider:'gateway',streamIdleTimeoutSec:299}).success,false);
 assert.equal(shape.customHeaders.__antFieldMeta.flatKey,'inferenceCustomHeaders');
 assert.equal(shape.customHeaders.__antAnn.redact,'presence');
 assert.equal(shape.sessionLifetimeSec.__antFieldMeta.flatKey,'inferenceSessionLifetimeSec');
 assert.equal(shape.sessionLifetimeSec.__antFieldMeta.predicates.show({inference:{credential:{kind:'interactive'}}}),true);
 assert.equal(shape.sessionLifetimeSec.__antFieldMeta.predicates.show({inference:{credential:{kind:'static'}}}),false);
 assert.equal(schema.safeParse({provider:'gateway',customHeaders:{'X-Example':'value'},sessionLifetimeSec:60,credential:{kind:'static',apiKey:'example',authScheme:'bearer'}}).success,true);
 assert.equal(schema.safeParse({provider:'gateway',customHeaders:{'X-Example':123}}).success,false);
 assert.equal(schema.safeParse({provider:'gateway',sessionLifetimeSec:0}).success,false);
 assert.equal(schema.safeParse({provider:'gateway',credential:{kind:'interactive',oidc:{clientId:'client'}}}).success,false);
});

test('gateway EAe union uses shipped arms and isolated URL message stubs',()=>{
 const schema=buildShippedGatewayCredentialPartialSchema(source);
 const arms=schema.options;
 assert.deepEqual(Array.from(arms,arm=>arm.shape.kind.value),['static','interactive','external-idp','helper-script']);
 assert.equal(arms[0].shape.apiKey.__antFieldMeta.flatKey,'inferenceGatewayApiKey');
 assert.equal(arms[1].shape.authFlow.__antFieldMeta.flatKey,'inferenceGatewayOidcAuthFlow');
 assert.equal(arms[1].shape.oidc.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 assert.equal(arms[2].shape.oidc.__antFieldMeta.flatKey,'inferenceIdpOidc');
 assert.equal(schema.safeParse({kind:'static',apiKey:'test',authScheme:'bearer'}).success,true);
 assert.equal(schema.safeParse({kind:'static',authScheme:'invalid'}).success,false);
 assert.equal(schema.safeParse({kind:'interactive',authFlow:'broker'}).success,true);
 assert.equal(schema.safeParse({kind:'interactive',authFlow:'invalid'}).success,false);
 assert.equal(schema.safeParse({kind:'external-idp',authFlow:'browser'}).success,true);
 assert.equal(schema.safeParse({kind:'helper-script'}).success,true);
 assert.equal(schema.safeParse({kind:'unknown'}).success,false);
});

test('gateway legacy rewrite and schema use original deprecation rules',()=>{
 const {schema,Tke,sAe}=buildShippedGatewayCredentialPartialSchema(source,{includeInternals:true});
 assert.equal(sAe.path,'inferenceGatewayAuthScheme: "sso"');
 assert.equal(Tke(sAe,'sso',{},0),undefined);
 assert.equal(Tke(sAe,'bearer',{},0),'bearer');
 for(const authScheme of ['sso','bearer','x-api-key','other']) {
  const rewritten=Tke(sAe,authScheme,{},0);
  const direct=schema.options[0].shape.authScheme.safeParse(authScheme);
  const expected=['bearer','x-api-key'].includes(rewritten);
  assert.equal(direct.success,expected,authScheme);
 }
 const dated={supportEnds:'2026-09-10',match:value=>value==='old',rewrite:()=> 'new'};
 assert.equal(Tke(dated,'old',{},Date.parse('2026-09-10T18:59:59.999Z')),'new');
 assert.equal(Tke(dated,'old',{},Date.parse('2026-09-10T19:00:00.000Z')),'old');
});

test('gateway OIDC deprecation metadata preserves original matching context',()=>{
 const {schema,bAe,xAe,SAe}=buildShippedGatewayCredentialPartialSchema(source,{includeInternals:true});
 const interactive=schema.options[1].shape;
 assert.equal(interactive.oidc.__antFieldMeta.deprecations[0],bAe);
 assert.equal(interactive.authFlow.__antFieldMeta.deprecations[0],xAe);
 assert.equal(bAe.path,'inferenceGatewayOidc');
 assert.equal(xAe.path,'inferenceGatewayOidcAuthFlow');
 assert.match(bAe.use,/inferenceIdpOidc/);
 const context={inferenceProvider:'gateway',inferenceGatewayOidc:'configured',inferenceCredentialKind:'interactive'};
 assert.equal(bAe.match('configured',context),true);
 assert.equal(xAe.match('broker',context),true);
 assert.equal(SAe.match('interactive',context),true);
 assert.equal(bAe.match('configured',{...context,inferenceProvider:'anthropic'}),false);
 assert.equal(xAe.match('broker',{...context,inferenceGatewayOidc:''}),false);
 assert.equal(SAe.match('static',context),false);
});

test('gateway EAe OIDC uses shipped validation, defaults and URL guards',()=>{
 const schema=buildShippedGatewayCredentialPartialSchema(source);
 const parse=oidc=>schema.safeParse({kind:'interactive',oidc});
 const good=parse({clientId:'client',issuer:'identity.example.com'});
 assert.equal(good.success,true);
 assert.equal(good.data.oidc.issuer,'https://identity.example.com');
 assert.equal(good.data.oidc.bearerTokenType,'id_token');
 assert.equal(good.data.oidc.appendOfflineAccess,true);
 assert.equal(parse({clientId:'client'}).success,false);
 assert.equal(parse({clientId:'',issuer:'https://identity.example.com'}).success,false);
 assert.equal(parse({clientId:'client',issuer:'http://identity.example.com'}).success,false);
 assert.equal(parse({clientId:'client',issuer:'https://identity.example.com',bearerTokenType:'access_token'}).success,false);
 assert.equal(parse({clientId:'client',issuer:'https://identity.example.com',bearerTokenType:'access_token',scopes:'api://gateway/.default'}).success,true);
 assert.equal(parse({clientId:'client',issuer:'https://identity.example.com',redirectPort:1023}).success,false);
 assert.equal(parse({clientId:'client',authorizationUrl:'https://identity.example.com/auth',tokenUrl:'https://identity.example.com/token'}).success,true);
});

test('gateway EAe helper uses shipped constraints including Windows paths',()=>{
 const schema=buildShippedGatewayCredentialPartialSchema(source);
 const parse=credential=>schema.safeParse({kind:'helper-script',...credential});
 const good=parse({command:'  /tmp/example  ',args:['--scope','api'],timeoutSec:600,awsEnv:{region:'us-east-1'}});
 assert.equal(good.success,true);assert.equal(good.data.command,'/tmp/example');
 assert.equal(parse({timeoutSec:601}).success,false);
 assert.equal(parse({ttlSec:0}).success,false);
 assert.equal(parse({args:['bad%value']}).success,false);
 assert.equal(parse({awsEnv:{region:'invalid'}}).success,false);
 assert.equal(parse({silentRefreshEnabled:'true'}).success,false);
 assert.equal(parse({commandWindows:'C:\\Tools\\helper.exe'}).success,true);
 assert.equal(parse({commandWindows:'relative.exe'}).success,false);
 assert.equal(parse({commandWindows:'\\\\server\\helper.exe'}).success,false);
});

test('anthropic provider uses shipped union, shared fields and metadata',()=>{
 const schema=buildShippedAnthropicPartialSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['provider','customHeaders','sessionLifetimeSec','credential']);
 assert.equal(schema.__antAnn.remotePolicy.hybrid.scope,'excluded');
 assert.equal(shape.customHeaders.__antFieldMeta.flatKey,'inferenceCustomHeaders');
 const options=shape.credential.unwrap().options;
 assert.deepEqual(Array.from(options,arm=>arm.shape.kind.value),['static','interactive','helper-script']);
 assert.equal(options[0].shape.apiKey.__antFieldMeta.flatKey,'inferenceAnthropicApiKey');
 assert.equal(options[0].shape.apiKey.__antAnn.redact,'drop');
 assert.equal(schema.safeParse({provider:'anthropic',credential:{kind:'static',apiKey:'example'}}).success,true);
 assert.equal(schema.safeParse({provider:'anthropic',credential:{kind:'interactive'}}).success,true);
 assert.equal(schema.safeParse({provider:'anthropic',credential:{kind:'helper-script',timeoutSec:601}}).success,false);
 assert.equal(schema.safeParse({provider:'gateway',credential:{kind:'static'}}).success,false);
 assert.equal(schema.safeParse({provider:'anthropic',credential:{kind:'external-idp'}}).success,false);
});

test('anthropic metadata callbacks use shipped bootstrap and sensitive-header logic',()=>{
 const schema=buildShippedAnthropicPartialSchema(source),shape=schema.shape;
 const options=shape.credential.unwrap().options;
 const required=options[0].shape.apiKey.__antFieldMeta.predicates.required;
 assert.equal(required({}),true);
 assert.equal(required({bootstrap:{url:'https://example.test'}}),false);
 assert.equal(required({bootstrap:{url:'https://example.test',enabled:false}}),true);
 assert.equal(options[0].shape.apiKey.__antFieldMeta.description.short.text,'');
 const show=options[2].shape.ttlSec.__antFieldMeta.predicates.show;
 assert.equal(show({inference:{credential:{kind:'helper-script',command:'/tool'}}}),true);
 assert.equal(show({inference:{credential:{kind:'static'}}}),false);
 const warn=shape.customHeaders.__antFieldMeta.predicates.warn;
 const intl={formatMessage:(message,values)=>({id:message.id,name:values.name})};
 assert.equal(warn({'X-Trace':'ordinary'},null,intl),null);
 assert.deepEqual({...warn({Authorization:'Bearer example'},null,intl)}, {id:'HdrCredWarnCredentialHelper',name:'Authorization'});
 assert.deepEqual({...warn({'X-Trace':'Bearer tokenvalue'},null,intl)}, {id:'HdrCredWarnCredentialHelper',name:'X-Trace'});
});

test('mantle provider uses shipped schema, credential arms and URL guards',()=>{
 const schema=buildShippedMantlePartialSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['provider','region','baseUrl','customHeaders','sessionLifetimeSec','credential']);
 assert.equal(shape.region.__antFieldMeta.flatKey,'inferenceBedrockRegion');
 assert.equal(shape.baseUrl.__antFieldMeta.flatKey,'inferenceBedrockBaseUrl');
 assert.equal(shape.baseUrl.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 assert.equal(shape.baseUrl.__antFieldMeta.remotePolicy.originPinned.carries,'local-credential');
 const arms=shape.credential.unwrap().options;
 assert.deepEqual(Array.from(arms,arm=>arm.shape.kind.value),['static','helper-script']);
 assert.equal(arms[0].shape.bearerToken.__antFieldMeta.flatKey,'inferenceBedrockBearerToken');
 assert.equal(arms[0].shape.bearerToken.__antAnn.redact,'drop');
 const good=schema.safeParse({provider:'mantle',region:'us-east-1',baseUrl:'example.com',credential:{kind:'static',bearerToken:'example'}});
 assert.equal(good.success,true);assert.equal(good.data.baseUrl,'https://example.com');
 assert.equal(schema.safeParse({provider:'mantle',region:'invalid'}).success,false);
 assert.equal(schema.safeParse({provider:'mantle',baseUrl:'ftp://example.com'}).success,false);
 assert.equal(schema.safeParse({provider:'mantle',credential:{kind:'helper-script',timeoutSec:601}}).success,false);
 assert.equal(schema.safeParse({provider:'mantle',credential:{kind:'interactive'}}).success,false);
 assert.equal(schema.safeParse({provider:'bedrock'}).success,false);
});

test('bedrock provider uses shipped fields and all credential arms',()=>{
 const schema=buildShippedBedrockPartialSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['provider','region','baseUrl','serviceTier','webIdentityRoleArn','customHeaders','sessionLifetimeSec','credential']);
 assert.equal(shape.serviceTier.__antFieldMeta.flatKey,'inferenceBedrockServiceTier');
 assert.equal(shape.webIdentityRoleArn.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 assert.equal(shape.webIdentityRoleArn.__antAnn.redact,'hash');
 const arms=shape.credential.unwrap().options;
 assert.deepEqual(Array.from(arms,arm=>arm.shape.kind.value),['static','interactive','vendor-profile','external-idp','helper-script']);
 assert.equal(arms[1].shape.ssoStartUrl.__antFieldMeta.flatKey,'inferenceBedrockSsoStartUrl');
 assert.equal(arms[1].shape.ssoStartUrl.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 assert.equal(arms[2].shape.profile.__antFieldMeta.flatKey,'inferenceBedrockProfile');
 assert.equal(arms[2].shape.awsDir.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 const good=schema.safeParse({provider:'bedrock',region:'us-east-1',serviceTier:'priority',webIdentityRoleArn:'arn:aws:iam::123456789012:role/example',credential:{kind:'interactive',ssoStartUrl:'identity.example.com',ssoRegion:'us-east-1'}});
 assert.equal(good.success,true);assert.equal(good.data.credential.ssoStartUrl,'https://identity.example.com');
 assert.equal(schema.safeParse({provider:'bedrock',serviceTier:'invalid'}).success,false);
 assert.equal(schema.safeParse({provider:'bedrock',webIdentityRoleArn:'not-an-arn'}).success,false);
 assert.equal(schema.safeParse({provider:'bedrock',credential:{kind:'interactive',ssoRegion:'invalid'}}).success,false);
 assert.equal(schema.safeParse({provider:'bedrock',credential:{kind:'interactive',ssoStartUrl:'https://u:p@example.com'}}).success,false);
 assert.equal(schema.safeParse({provider:'bedrock',credential:{kind:'vendor-profile',profile:'default'}}).success,true);
 assert.equal(schema.safeParse({provider:'bedrock',credential:{kind:'external-idp',authFlow:'browser'}}).success,true);
 assert.equal(schema.safeParse({provider:'bedrock',credential:{kind:'helper-script',timeoutSec:601}}).success,false);
 assert.equal(schema.safeParse({provider:'mantle'}).success,false);
});

test('foundry provider uses shipped validation, credential arms and metadata',()=>{
 const schema=buildShippedFoundryPartialSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['provider','resource','baseUrl','customHeaders','sessionLifetimeSec','credential']);
 assert.equal(shape.resource.__antFieldMeta.flatKey,'inferenceFoundryResource');
 assert.equal(shape.resource.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 assert.equal(shape.baseUrl.__antFieldMeta.flatKey,'inferenceFoundryBaseUrl');
 assert.equal(shape.baseUrl.__antFieldMeta.remotePolicy.originPinned.carries,'local-credential');
 const arms=shape.credential.unwrap().options;
 assert.deepEqual(Array.from(arms,arm=>arm.shape.kind.value),['static','interactive','helper-script']);
 assert.equal(arms[0].shape.apiKey.__antFieldMeta.flatKey,'inferenceFoundryApiKey');
 assert.equal(arms[0].shape.apiKey.__antAnn.redact,'drop');
 assert.equal(arms[1].shape.tenantId.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 assert.equal(arms[1].shape.clientId.__antFieldMeta.predicates.required({}),true);
 assert.equal(arms[1].shape.clientId.__antFieldMeta.predicates.required({bootstrap:{url:'https://config.example'}}),false);
 const good=schema.safeParse({provider:'foundry',resource:'  my-resource  ',baseUrl:'example.com',credential:{kind:'interactive',tenantId:' tenant ',authFlow:'broker'}});
 assert.equal(good.success,true);assert.equal(good.data.resource,'my-resource');
 assert.equal(good.data.baseUrl,'https://example.com');assert.equal(good.data.credential.tenantId,'tenant');
 assert.equal(schema.safeParse({provider:'foundry',resource:'UpperCase'}).success,false);
 assert.equal(schema.safeParse({provider:'foundry',baseUrl:'ftp://example.com'}).success,false);
 assert.equal(schema.safeParse({provider:'foundry',credential:{kind:'interactive',authFlow:'invalid'}}).success,false);
 assert.equal(schema.safeParse({provider:'foundry',credential:{kind:'interactive',tenantId:' '}}).success,false);
 assert.equal(schema.safeParse({provider:'foundry',credential:{kind:'helper-script',timeoutSec:601}}).success,false);
 assert.equal(schema.safeParse({provider:'foundry',credential:{kind:'external-idp'}}).success,false);
 assert.equal(schema.safeParse({provider:'bedrock'}).success,false);
});

test('vertex provider uses shipped credential, workforce OIDC and field validation',()=>{
 const schema=buildShippedVertexPartialSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['provider','projectId','region','baseUrl','customHeaders','sessionLifetimeSec','credential']);
 assert.equal(shape.projectId.__antFieldMeta.flatKey,'inferenceVertexProjectId');
 assert.equal(shape.projectId.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 assert.equal(shape.projectId.__antAnn.redact,'hash');
 assert.equal(shape.baseUrl.__antFieldMeta.remotePolicy.originPinned.carries,'local-credential');
 const arms=shape.credential.unwrap().options;
 assert.deepEqual(Array.from(arms,arm=>arm.shape.kind.value),['interactive','workforce','vendor-profile','helper-script']);
 assert.equal(arms[0].shape.clientSecret.__antAnn.redact,'presence');
 assert.equal(arms[1].shape.audience.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 assert.equal(arms[1].shape.oidc.__antFieldMeta.flatKey,'inferenceVertexWorkforceOidc');
 assert.equal(arms[1].shape.oidc.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 assert.equal(arms[1].shape.authFlow.__antFieldMeta.notAPresenceSignal,true);
 assert.equal(arms[2].shape.credentialsFile.__antAnn.pathKind,'file');
 const good=schema.safeParse({provider:'vertex',projectId:' my-project ',region:'us-east5',baseUrl:'example.com',credential:{kind:'workforce',authFlow:'browser',oidc:{clientId:'client',issuer:'id.example.com'}}});
 assert.equal(good.success,true);assert.equal(good.data.projectId,'my-project');assert.equal(good.data.baseUrl,'https://example.com');
 assert.equal(good.data.credential.oidc.issuer,'https://id.example.com');
 for(const region of ['global','eu','us','us-east5'])assert.equal(schema.safeParse({provider:'vertex',region}).success,true,region);
 assert.equal(schema.safeParse({provider:'vertex',region:'invalid'}).success,false);
 assert.equal(schema.safeParse({provider:'vertex',projectId:'UPPER'}).success,false);
 assert.equal(schema.safeParse({provider:'vertex',credential:{kind:'workforce',oidc:{clientId:'client'}}}).success,false);
 assert.equal(schema.safeParse({provider:'vertex',credential:{kind:'workforce',authFlow:'invalid'}}).success,false);
 assert.equal(schema.safeParse({provider:'vertex',credential:{kind:'helper-script',timeoutSec:601}}).success,false);
 assert.equal(schema.safeParse({provider:'vertex',credential:{kind:'static'}}).success,false);
 assert.equal(schema.safeParse({provider:'foundry'}).success,false);
});

test('shipped inference union and actual collector preserve provider and credential contexts',()=>{
 const schema=buildShippedInferencePartialSchema(source),collect=buildShippedFieldCollector(source);
 assert.deepEqual(Array.from(schema.options,arm=>arm.shape.provider.value),['gateway','anthropic','bedrock','mantle','vertex','foundry']);
 const bedrock=schema.options[2].__antVariantMeta;
 assert.equal(bedrock.cliFlag,'CLAUDE_CODE_USE_BEDROCK');
 assert.deepEqual(Array.from(bedrock.needsBaseUrlFor),['external-idp']);
 for(const provider of ['gateway','anthropic','bedrock','mantle','vertex','foundry'])assert.equal(schema.safeParse({provider}).success,true,provider);
 assert.equal(schema.safeParse({provider:'unknown'}).success,false);
 assert.equal(schema.safeParse({provider:'foundry',credential:{kind:'workforce'}}).success,false);
 assert.equal(schema.safeParse({provider:'vertex',credential:{kind:'workforce',oidc:{clientId:'client',issuer:'id.example.com'}}}).success,true);
 const entries=collect(schema);
 assert.equal(entries.size,48);
 const shared=entries.get('inferenceCustomHeaders');
 assert.deepEqual(Array.from(shared.armContext.providers),['gateway','anthropic','bedrock','mantle','vertex','foundry']);
 assert.deepEqual(Array.from(shared.armContext.credentialKinds),[]);
 assert.deepEqual(Array.from(entries.get('inferenceBedrockRegion').armContext.providers),['bedrock','mantle']);
 const workforce=entries.get('inferenceVertexWorkforceOidc');
 assert.deepEqual(Array.from(workforce.path),['credential','oidc']);
 assert.deepEqual(Array.from(workforce.armContext.providers),['vertex']);
 assert.deepEqual(Array.from(workforce.armContext.credentialKinds),['workforce']);
 const foundry=entries.get('inferenceFoundryApiKey');
 assert.deepEqual(Array.from(foundry.armContext.providers),['foundry']);
 assert.deepEqual(Array.from(foundry.armContext.credentialKinds),['static']);
});

test('bootstrap cluster uses shipped URL, OIDC and helper path validation',()=>{
 const schema=buildShippedBootstrapPartialSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['enabled','url','oidc','headers','headersHelper','trustBootstrapDelivery']);
 for(const field of Object.values(shape))assert.equal(field.__antFieldMeta.remotePolicy.type,'remote-disabled');
 assert.equal(shape.enabled.__antFieldMeta.default,true);
 assert.equal(shape.trustBootstrapDelivery.__antFieldMeta.default,false);
 assert.equal(shape.trustBootstrapDelivery.__antFieldMeta.failClosedValue,false);
 assert.equal(shape.headers.__antAnn.redact,'presence');
 assert.equal(shape.headersHelper.__antAnn.pathKind,'file');
 assert.equal(shape.url.__antFieldMeta.activatesThirdPartyMode({bootstrap:{url:'https://example.com'}},false),true);
 assert.equal(shape.url.__antFieldMeta.activatesThirdPartyMode({bootstrap:{url:'https://example.com',enabled:false}},false),false);
 assert.equal(shape.enabled.__antFieldMeta.predicates.show({bootstrap:{url:'https://example.com'}}),true);
 const good=schema.safeParse({url:'config.example.com',oidc:{clientId:'client',issuer:'id.example.com',scopes:'api/.default'},headers:{'X-Test':'example'},headersHelper:'C:/Tools/helper.exe'});
 assert.equal(good.success,true);assert.equal(good.data.url,'https://config.example.com');assert.equal(good.data.oidc.issuer,'https://id.example.com');
 assert.equal(schema.safeParse({url:'ftp://config.example.com'}).success,false);
 assert.equal(schema.safeParse({oidc:{clientId:'client',issuer:'id.example.com'}}).success,false);
 assert.equal(schema.safeParse({oidc:{clientId:'client',scopes:'api/.default'}}).success,false);
 assert.equal(schema.safeParse({headers:{'X-Test':1}}).success,false);
 assert.equal(schema.safeParse({headersHelper:'relative.exe'}).success,false);
 assert.equal(schema.safeParse({headersHelper:'\\\\server\\helper.exe'}).success,false);
 assert.equal(schema.safeParse({trustBootstrapDelivery:'true'}).success,false);
 const entries=buildShippedFieldCollector(source)(schema);
 assert.deepEqual(Array.from(entries.keys()),['bootstrapEnabled','bootstrapUrl','bootstrapOidc','bootstrapHeaders','bootstrapHeadersHelper','trustBootstrapDelivery']);
});

test('self-hosted schema uses shipped credentials and distinct remote URL policy',()=>{
 const schema=buildShippedSelfHostedPartialSchema(source),shape=schema.shape;
 assert.deepEqual(Object.keys(shape),['url','credential']);
 assert.equal(schema.__antAnn.remotePolicy.hybrid.scope,'excluded');
 const meta=shape.url.__antFieldMeta;
 assert.equal(meta.flatKey,'selfHostedUrl');assert.equal(meta.remotePolicy.requiresUserConsent,true);
 assert.equal(meta.remotePolicy.rejectLoopback,true);assert.equal(meta.remotePolicy.hybrid.scope,'excluded');
 assert.equal(meta.predicates.required({selfHosted:{}}),true);assert.equal(meta.predicates.required({}),false);
 const arms=shape.credential.unwrap().options;
 assert.deepEqual(Array.from(arms,arm=>arm.shape.kind.value),['static','helper-script','external-idp']);
 assert.equal(arms[0].shape.bearerToken.__antFieldMeta.flatKey,'selfHostedToken');
 assert.equal(arms[0].shape.bearerToken.__antAnn.redact,'drop');
 assert.equal(schema.safeParse({url:'http://localhost:3000',credential:{kind:'static',bearerToken:' token '}}).success,true);
 assert.equal(schema.safeParse({url:'https://host.example/path?x=1'}).success,false);
 assert.equal(schema.safeParse({url:'https://host.example/path#fragment'}).success,false);
 assert.equal(schema.safeParse({url:'http://host.example/path'}).success,false);
 assert.equal(schema.safeParse({credential:{kind:'static',bearerToken:' '}}).success,false);
 assert.equal(schema.safeParse({credential:{kind:'helper-script',timeoutSec:601}}).success,false);
 assert.equal(schema.safeParse({credential:{kind:'external-idp',oidc:{clientId:'client',issuer:'id.example.com'}}}).success,true);
 assert.equal(schema.safeParse({credential:{kind:'interactive'}}).success,false);
 assert.throws(()=>meta.egressRequirements('https://host.example'),/egress dependency not extracted/);
 const entries=buildShippedFieldCollector(source)(schema);
 assert.ok(entries.has('selfHostedUrl'));assert.ok(entries.has('selfHostedToken'));
 assert.ok(entries.has('inferenceIdpOidc'));assert.ok(entries.has('inferenceCredentialHelper'));
});


test('shipped dictation and token limits retain metadata and numeric boundaries',()=>{
 const {dictation,tokenLimits}=buildShippedLimitsAndDictationSchemas(source);
 const collector=buildShippedFieldCollector(source);
 assert.deepEqual(Array.from(collector(dictation).keys()),['dictationEnabled']);
 assert.deepEqual(Array.from(collector(tokenLimits).keys()),['inferenceMaxTokensPerWindow','inferenceTokenWindowHours']);
 const enabled=dictation.shape.enabled.__antFieldMeta;
 assert.equal(enabled.remotePolicy.hybrid.scope,'excluded');
 assert.equal(enabled.remotePolicy.hotApplied,true);
 assert.equal(dictation.safeParse({enabled:true}).success,true);
 assert.equal(dictation.safeParse({enabled:'true'}).success,false);
 const hours=tokenLimits.shape.windowHours.__antFieldMeta;
 assert.equal(hours.predicates.required({tokenLimits:{maxPerWindow:1}}),true);
 assert.equal(hours.predicates.required({tokenLimits:{}}),false);
 assert.equal(hours.remotePolicy.hotApplied,true);
 assert.equal(tokenLimits.safeParse({maxPerWindow:1,windowHours:720}).success,true);
 for(const value of [0,-1,1.5,721])assert.equal(tokenLimits.safeParse({windowHours:value}).success,false);
 assert.equal(tokenLimits.safeParse({maxPerWindow:0}).success,false);
});


test('shipped Entra lazy schema validates client ID, clouds and normalized scopes',()=>{
 const schema=buildShippedEntraSchema(source);
 assert.deepEqual(Array.from(buildShippedFieldCollector(source)(schema).keys()),['entraClientId','entraAzureCloud','entraScope']);
 for(const field of Object.values(schema.shape)){
  assert.deepEqual(Array.from(field.__antFieldMeta.readers),['m365']);
  assert.equal(field.__antFieldMeta.remotePolicy.requiresUserConsent,true);
 }
 const parsed=schema.safeParse({clientId:' 550e8400-e29b-41d4-a716-446655440000 ',azureCloud:'china',scope:' one,  two '});
 assert.equal(parsed.success,true);assert.equal(parsed.data.clientId,'550e8400-e29b-41d4-a716-446655440000');
 assert.equal(parsed.data.scope,'one two');
 assert.equal(schema.safeParse({clientId:'invalid'}).success,false);
 assert.equal(schema.safeParse({azureCloud:'other'}).success,false);
 assert.equal(schema.safeParse({scope:',,  '}).success,false);
});
