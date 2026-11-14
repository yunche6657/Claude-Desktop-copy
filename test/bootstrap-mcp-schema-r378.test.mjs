import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {buildShippedMcpPartialSchema,buildShippedMcpStdioSchema,buildShippedMcpOAuthSchema,buildShippedMcpRemotePartialSchema,buildShippedManagedMcpSchemas,buildShippedMcpManagedField,buildShippedZodSubset,buildShippedConsentTraversal,buildShippedFieldCollector,inspectPcBranchCoverage}=require('../tools/inspect-bootstrap-registry.cjs');
const {createConsentTargetExtractor}=require('../desktop/hybrid-bootstrap-consent-targets.cjs');
const source=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
test('original MCP direct fields retain fail-closed metadata and bounds',()=>{
 const schema=buildShippedMcpPartialSchema(source),fields=buildShippedFieldCollector(source)(schema);
 assert.equal(Object.keys(schema.shape).length,8);
 assert.equal(fields.has('managedMcpServers'),false);
 assert.equal(fields.get('mcpPersistentAlwaysAllowEnabled').node.__antFieldMeta.failClosedValue,false);
 assert.equal(fields.get('mcpScheduledTaskApprovalLifetimeDays').node.__antFieldMeta.failClosedValue,0);
 assert.equal(fields.get('mcpScheduledTaskApprovalLifetimeDays').node.__antFieldMeta.remotePolicy.applyUnverified,'asFailClosed');
 assert.deepEqual(plain(fields.get('deniedPluginMcpServers').node.__antFieldMeta.failClosedValue),[{serverUrl:'*'}]);
 assert.deepEqual(plain(fields.get('isLocalDevMcpEnabled').node.__antFieldMeta.egressRequirements(true)),['github.com','objects.githubusercontent.com','pypi.org','files.pythonhosted.org']);
 assert.deepEqual(plain(fields.get('isLocalDevMcpEnabled').node.__antFieldMeta.egressRequirements(false)),[]);
 assert.equal(fields.get('allowedPluginMcpServers').node.__antFieldMeta.predicates.warn({serverUrl:'example.com'}).id,'itOI+H+YoF');
 const parsed=schema.safeParse({scheduledTaskApprovalLifetimeDays:'30',allowedPluginServers:[{serverUrl:' https://example.test/* '},{serverUrl:' '}]});
 assert.equal(parsed.success,true);
 assert.equal(parsed.data.scheduledTaskApprovalLifetimeDays,30);
 assert.deepEqual(plain(parsed.data.allowedPluginServers),[{serverUrl:'https://example.test/*'}]);
 assert.equal(schema.safeParse({scheduledTaskApprovalLifetimeDays:'3651'}).success,false);
 assert.equal(schema.safeParse({toolTimeoutSec:59}).success,false);
 assert.equal(schema.safeParse({toolTimeoutSec:3600}).success,true);
 assert.deepEqual([...buildShippedConsentTraversal(source)(schema)],[]);
 assert.ok(inspectPcBranchCoverage(source).missing.includes('mcp'));
});
test('original remote arm exposes OAuth and headers helper consent',()=>{
 const schema=buildShippedMcpRemotePartialSchema(source);
 assert.deepEqual([...buildShippedConsentTraversal(source)(schema)],['oauth.clientSecretHelper','headersHelper']);
 assert.equal(schema.safeParse({name:'remote',transport:'http',url:'http://localhost:8080',headersHelper:'helper'}).success,true);
 assert.equal(schema.safeParse({name:'remote',transport:'sse',url:'http://example.test'}).success,false);
 assert.equal(schema.safeParse({name:'remote',transport:'http',url:'https://example.test',headersHelperTtlSec:0}).success,false);
});
test('original OAuth schema preprocesses legacy and validates cross-field constraints',()=>{
 const schema=buildShippedMcpOAuthSchema(source);
 assert.deepEqual(plain(schema.parse(true)),{mode:'dcr'});
 assert.equal(schema.parse(false),undefined);
 assert.deepEqual(plain(schema.parse({scope:'read'})),{scope:'read',mode:'byo',asSelection:{via:'prm'}});
 const config=schema.safeParse({mode:'byo',clientId:' client ',clientSecretHelper:'helper',authorizationServer:['https://issuer.test']});
 assert.equal(config.success,true);
 assert.equal(config.data.clientId,'client');
 assert.deepEqual(plain(config.data.asSelection),{via:'issuer',authorizationServer:['https://issuer.test']});
 assert.equal(schema.safeParse({mode:'byo',clientSecretHelper:'helper'}).success,false);
 assert.equal(schema.safeParse({mode:'byo',clientId:'c',authFlow:'broker',tenantId:'common',scope:'read'}).success,false);
 assert.equal(schema.safeParse({mode:'hosted',authorizationServer:['https://issuer.test']}).success,true);
});
test('original pLe extracts remote OAuth and header helper from real Zod arm',()=>{
 const schema=buildShippedZodSubset(source).A(buildShippedMcpRemotePartialSchema(source));
 const traverse=buildShippedConsentTraversal(source),keys=['managedMcpServers'];
 const fragment=source.slice(source.indexOf('function uLe('),source.indexOf('function mLe('));
 const env={wAe:()=>undefined,es:JSON.stringify,lFe:()=>[],Yc:()=>keys,yFe:()=>false,eTe:()=>false,Bc:{shape:{managedMcpServers:schema}},pTe:traverse,URL};
 vm.createContext(env);vm.runInContext(fragment,env);
 const extract=createConsentTargetExtractor({consentKeys:()=>[],allKeys:()=>keys,isFailClosed:()=>false,isUrlField:()=>false,nestedPaths:()=>traverse(schema),formerLabel:()=>undefined,serialize:JSON.stringify});
 const input={managedMcpServers:[{name:'remote',transport:'http',url:'https://example.test',headersHelper:'headers',oauth:{mode:'byo',clientId:'client',clientSecretHelper:'secret',authorizationServer:['https://issuer.test']}}]};
 const result=extract(input);
 assert.deepEqual(plain(result),plain(env.pLe(input)));
 assert.equal(result[0].label,'managedMcpServers[remote]');
 assert.deepEqual(JSON.parse(result[0].value),{'oauth.clientSecretHelper':'secret',headersHelper:'headers'});
});
test('original pLe extracts stdio entries including duplicate names',()=>{
 const schema=buildShippedZodSubset(source).A(buildShippedMcpStdioSchema(source));
 const traverse=buildShippedConsentTraversal(source),keys=['managedMcpServers'];
 const fragment=source.slice(source.indexOf('function uLe('),source.indexOf('function mLe('));
 const env={wAe:()=>undefined,es:JSON.stringify,lFe:()=>[],Yc:()=>keys,yFe:()=>false,eTe:()=>false,Bc:{shape:{managedMcpServers:schema}},pTe:traverse,URL};
 vm.createContext(env);vm.runInContext(fragment,env);
 const extract=createConsentTargetExtractor({consentKeys:()=>[],allKeys:()=>keys,isFailClosed:()=>false,isUrlField:()=>false,nestedPaths:()=>traverse(schema),formerLabel:()=>undefined,serialize:JSON.stringify});
 const input={managedMcpServers:[{name:'tools',transport:'stdio',command:'npx',args:['first']},{name:'tools',transport:'stdio',command:'node',env:{X:'1'}}]};
 const actual=extract(input);
 assert.deepEqual(plain(actual),plain(env.pLe(input)));
 assert.deepEqual(actual.map(value=>value.label),['managedMcpServers[tools]','managedMcpServers[tools]#2']);
});
test('shipped managed MCP union preprocesses and validates builtin and transport arms',()=>{
 const {entry,list}=buildShippedManagedMcpSchemas(source);
 const web=entry.safeParse({name:'search',server:'websearch',provider:'custom',customUrl:'https://search.test',headersHelper:'helper',toolPolicy:{read:'bogus'}});
 assert.equal(web.success,true);
 assert.equal(web.data.toolPolicy.read,'blocked');
 assert.equal(entry.safeParse({name:'search',server:'websearch',provider:'custom'}).success,false);
 assert.equal(entry.safeParse({name:'git',server:'github',clientId:'abc',host:'https://git.example.test/path'}).data.host,'https://git.example.test');
 assert.equal(entry.safeParse({name:'office',server:'microsoft365',tenantId:'common',clientId:'abc',authorityHost:null,scope:'User.Read offline_access'}).success,true);
 assert.equal(entry.safeParse({name:'office',server:'microsoft365',tenantId:'common',clientId:'abc',scope:'Invalid.Permission'}).success,false);
 assert.equal(entry.safeParse({name:'p',transport:'policy-only',toolPolicy:{read:'ask'}}).success,true);
 assert.equal(entry.safeParse({name:'p',transport:'policy-only',command:'npx'}).success,false);
 const parsed=list.safeParse([{name:'a',transport:'stdio',command:'npx',toolPolicy:{read:'nonsense'}},{name:'bad',transport:'stdio',command:'../bad'}]);
 assert.equal(parsed.success,true);
 assert.equal(parsed.data.length,1);
 assert.equal(parsed.data[0].toolPolicy.read,'blocked');
 assert.equal(list.safeParse([{name:'same',transport:'stdio',command:'npx'},{name:'same',transport:'stdio',command:'node'}]).success,false);
 assert.equal(list.safeParse([{name:'w1',server:'websearch',provider:'custom',customUrl:'https://a.test'},{name:'w2',server:'websearch',provider:'custom',customUrl:'https://b.test'}]).success,false);
 assert.deepEqual([...buildShippedConsentTraversal(source)(list)],['headersHelper','oauth.clientSecretHelper','command','args','env','envHelper']);
});
test('native pLe traverses the original managed MCP union across all server kinds',()=>{
 const {list}=buildShippedManagedMcpSchemas(source),traverse=buildShippedConsentTraversal(source),keys=['managedMcpServers'];
 const fragment=source.slice(source.indexOf('function uLe('),source.indexOf('function mLe('));
 const env={wAe:()=>undefined,es:JSON.stringify,lFe:()=>[],Yc:()=>keys,yFe:()=>false,eTe:()=>false,Bc:{shape:{managedMcpServers:list}},pTe:traverse,URL};
 vm.createContext(env);vm.runInContext(fragment,env);
 const extract=createConsentTargetExtractor({consentKeys:()=>[],allKeys:()=>keys,isFailClosed:()=>false,isUrlField:()=>false,nestedPaths:()=>traverse(list),formerLabel:()=>undefined,serialize:JSON.stringify});
 const parsed=list.parse([{name:'search',server:'websearch',provider:'custom',customUrl:'https://search.test',headersHelper:'h'},
  {name:'local',transport:'stdio',command:'npx',args:['one'],env:{X:'1'}},
  {name:'remote',transport:'http',url:'https://example.test',oauth:{mode:'byo',clientId:'c',clientSecretHelper:'helper',authorizationServer:['https://issuer.test']}}]);
 const actual=extract({managedMcpServers:parsed});
 assert.deepEqual(plain(actual),plain(env.pLe({managedMcpServers:parsed})));
 assert.deepEqual(actual.map(row=>row.label),['managedMcpServers[search]','managedMcpServers[local]','managedMcpServers[remote]']);
 assert.deepEqual(JSON.parse(actual[2].value),{'oauth.clientSecretHelper':'helper'});
});
test('original managed MCP diagnostic callback reports dropped policies and invalid entries',()=>{
 const {checkDropped}=buildShippedManagedMcpSchemas(source),issues=[];
 checkDropped([{name:'local',transport:'stdio',command:'npx',toolPolicy:{run:'unknown'}},
  {name:'invalid',transport:'stdio',command:'../escape'},
  {name:'remote',transport:'http',url:'https://example.test',oauth:{mode:'byo',clientSecretHelper:'helper'}}],(...args)=>issues.push(args));
 assert.equal(issues.length,3);
 assert.match(issues[0][0],/toolPolicy\.run.*treated as "blocked"/);
 assert.equal(issues[0][1],'drop');
 assert.match(issues[1][0],/entry "invalid" dropped.*command/);
 assert.match(issues[2][0],/entry "remote" dropped.*oauth/);
});
test('original managed MCP egress callback calculates builtin, remote and OAuth hosts',()=>{
 const field=buildShippedMcpManagedField(source);
 const parsed=field.parse([
  {name:'office',server:'microsoft365',tenantId:'common',clientId:'c',azureCloud:'us-gov-high'},
  {name:'search',server:'websearch',provider:'custom',customUrl:'https://search.example/path'},
  {name:'git',server:'github',clientId:'c'},
  {name:'local',transport:'stdio',command:'npx'},
  {name:'remote',transport:'http',url:'https://mcp.example/path',oauth:{mode:'byo',clientId:'c',authorizationServer:['https://issuer.example/']}}
 ]);
 assert.deepEqual(plain(field.__antFieldMeta.egressRequirements(parsed)),['graph.microsoft.us','login.microsoftonline.us','search.example','github.com','api.github.com','mcp.example','issuer.example']);
 const tenant=field.parse([{name:'remote',transport:'http',url:'https://mcp.example',oauth:{mode:'byo',clientId:'c',tenantId:'common',scope:'read'}}]);
 assert.deepEqual(plain(field.__antFieldMeta.egressRequirements(tenant)),['mcp.example','login.microsoftonline.com']);
});
test('original stdio arm exposes execution consent fields and validates paths',()=>{
 const schema=buildShippedMcpStdioSchema(source);
 assert.deepEqual([...buildShippedConsentTraversal(source)(schema)],['command','args','env','envHelper']);
 assert.equal(schema.safeParse({name:'tools',transport:'stdio',command:'npx',args:['server'],env:{A:'b'},envHelper:'C:\\tools\\env.exe'}).success,true);
 for(const command of ['../program','\\\\server\\share\\x','npx;echo']) assert.equal(schema.safeParse({name:'tools',transport:'stdio',command}).success,false,command);
 assert.equal(schema.safeParse({name:'tools',transport:'stdio',command:'npx',envHelper:'../env'}).success,false);
 assert.equal(schema.safeParse({name:'tools',transport:'stdio',command:'npx',startupTimeoutSec:4}).success,false);
 assert.equal(schema.safeParse({name:'tools',transport:'stdio',command:'npx',toolPolicy:{shell:'invalid'}}).success,false);
});
