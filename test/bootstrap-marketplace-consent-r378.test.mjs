import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {buildShippedMarketplaceSchema,buildShippedSpreadSchemas,buildShippedConsentTraversal,inspectPcBranchCoverage}=require('../tools/inspect-bootstrap-registry.cjs');
const {createConsentTargetExtractor}=require('../desktop/hybrid-bootstrap-consent-targets.cjs');
const source=readFileSync(new URL('../../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js',import.meta.url),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
test('Pc coverage reports missing root members and refuses unrecognized initializers',()=>{
 const coverage=inspectPcBranchCoverage(source);
 assert.equal(coverage.complete,false);
 assert.equal(coverage.branches.length,26);
 assert.deepEqual(coverage.spreads,['sPe']);
 assert.ok(coverage.missing.includes('plugins'));
 assert.ok(coverage.missing.includes('mcp'));
 assert.throws(()=>inspectPcBranchCoverage(source.replace('Pc=j({inference:', 'Pc=j({unexpected:42,inference:')),/Unexpected Pc root member/);
});
test('original Pc spread provides both fields and import consent subfields',()=>{
 const schemas=buildShippedSpreadSchemas(source), traverse=buildShippedConsentTraversal(source);
 assert.deepEqual(Object.keys(schemas),['claudeAiImport','banner']);
 assert.deepEqual([...traverse(schemas.claudeAiImport)],['url','oauthIssuer','oauthClientId']);
 assert.deepEqual([...traverse(schemas.banner)],[]);
 assert.equal(schemas.claudeAiImport.safeParse({url:'https://example.test'}).success,false);
 const parsed=schemas.claudeAiImport.safeParse({url:'http://localhost:1234',oauthIssuer:'https://issuer.test',oauthClientId:' client ',allowedOrganizationUuids:[' 123e4567-e89b-12d3-a456-426614174000 ', 'bad']});
 assert.equal(parsed.success,true);
 assert.equal(parsed.data.oauthClientId,'client');
 assert.deepEqual(plain(parsed.data.allowedOrganizationUuids),['123e4567-e89b-12d3-a456-426614174000']);
});
test('original pLe extracts Claude import consent as one nested target',()=>{
 const schema=buildShippedSpreadSchemas(source).claudeAiImport, traverse=buildShippedConsentTraversal(source);
 const keys=['claudeAiImport'],fragment=source.slice(source.indexOf('function uLe('),source.indexOf('function mLe('));
 const env={wAe:()=>undefined,es:JSON.stringify,lFe:()=>[],Yc:()=>keys,yFe:()=>false,eTe:()=>false,Bc:{shape:{claudeAiImport:schema}},pTe:traverse,URL};
 vm.createContext(env);vm.runInContext(fragment,env);
 const extractor=createConsentTargetExtractor({consentKeys:()=>[],allKeys:()=>keys,isFailClosed:()=>false,isUrlField:()=>false,nestedPaths:()=>traverse(schema),formerLabel:()=>undefined,serialize:JSON.stringify});
 const input={claudeAiImport:{url:'https://export.test',oauthIssuer:'https://issuer.test',oauthClientId:'client',enabled:true}};
 const actual=extractor(input);
 assert.deepEqual(plain(actual),plain(env.pLe(input)));
 assert.deepEqual(actual[0].subfields,['url','oauthIssuer','oauthClientId']);
});
test('original marketplace Zod preserves consent paths and filters malformed entries',()=>{
 const schema=buildShippedMarketplaceSchema(source), traverse=buildShippedConsentTraversal(source);
 assert.deepEqual([...traverse(schema)],['credentialHelper']);
 const parsed=schema.safeParse([{source:'github',repo:'Org/Repo',credentialKind:'credentialHelper',credentialHelper:'helper'}, {source:'github',repo:'broken',credentialKind:'credentialHelper'}, {source:'url',url:'https://example.test',installationPreference:'required'}]);
 assert.equal(parsed.success,true);
 assert.deepEqual(plain(parsed.data),[{source:'github',repo:'org/repo',credentialKind:'credentialHelper',credentialHelper:'helper'},{source:'url',url:'https://example.test',installationPreference:'available'}]);
});
test('original pLe uses the actual marketplace schema for nested targets',()=>{
 const schema=buildShippedMarketplaceSchema(source),traverse=buildShippedConsentTraversal(source);
 const keys=['allowedPluginMarketplaces'],fragment=source.slice(source.indexOf('function uLe('),source.indexOf('function mLe('));
 const env={wAe:()=>undefined,es:JSON.stringify,lFe:()=>[],Yc:()=>keys,yFe:()=>false,eTe:()=>false,Bc:{shape:{allowedPluginMarketplaces:schema}},pTe:traverse,URL};
 vm.createContext(env);vm.runInContext(fragment,env);
 const extractor=createConsentTargetExtractor({consentKeys:()=>[],allKeys:()=>keys,isFailClosed:()=>false,isUrlField:()=>false,nestedPaths:()=>traverse(schema),formerLabel:()=>undefined,serialize:JSON.stringify});
 const input={allowedPluginMarketplaces:[{source:'github',repo:'org/repo',credentialHelper:'first'},{source:'github',repo:'org/repo',credentialHelper:'second'},{source:'url',url:'https://example.test'}]};
 const result=extractor(input);
 assert.deepEqual(plain(result),plain(env.pLe(input)));
 assert.deepEqual(result.map(x=>x.label),['allowedPluginMarketplaces[org/repo]','allowedPluginMarketplaces[org/repo]#2']);
});
