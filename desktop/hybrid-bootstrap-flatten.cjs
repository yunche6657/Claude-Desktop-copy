'use strict';
// Version dispatch mirrors tLe/XIe; callers must supply the full upstream
// cluster-name inventory and audited per-cluster flatteners. Unknown clusters are
// retained and reported as unresolved, never silently accepted or discarded.
function flattenBootstrap(input,{clusterNames=[],clusters={}}={}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {flat:{},version:1,warnings:[],unread:[],unresolved:[]};
  const explicit=input.$schemaVersion;
  const version=typeof explicit==='number'&&Number.isInteger(explicit)&&explicit>=1 ? explicit : clusterNames.some(k=>input[k]!==undefined)?2:1;
  const flat={...input}; delete flat.$schemaVersion; delete flat.$schema;
  const warnings=[],unread=[],unresolved=[];
  if(version===1)return {flat,version,warnings,unread,unresolved};
  for(const key of clusterNames) {
    let value=flat[key];
    const entry=Object.hasOwn(clusters,key)?clusters[key]:undefined;
    if(!entry){if(value!==undefined)unresolved.push(key);continue;}
    delete flat[key];
    if(value==null)continue;
    if(typeof value==='string')try{value=JSON.parse(value)}catch{}
    if(!value||typeof value!=='object'||Array.isArray(value)) {
      warnings.push(`Failed to parse bootstrap cluster "${key}": expected object, got ${Array.isArray(value)?'array':value===null?'null':typeof value}`);continue;
    }
    value={...value};
    const roots=new Set(Object.keys(entry.propMap??{}).filter(k=>k.includes('.')).map(k=>k.slice(0,k.indexOf('.'))));
    for(const root of roots){let part=value[root];if(part!=null){if(typeof part==='string')try{part=JSON.parse(part)}catch{};if(part&&typeof part==='object'&&!Array.isArray(part)){value[root]=part;continue;}warnings.push(`Failed to parse bootstrap cluster "${key}.${root}": expected object, got ${Array.isArray(part)?'array':part===null?'null':typeof part}`);delete value[root];}}
    if(typeof entry.findUnread==='function')unread.push(...entry.findUnread(value));
    else unresolved.push(`${key}:unread-check`);
    try { Object.assign(flat,entry.flatten(value)); }
    catch(error){warnings.push(`Failed to parse bootstrap cluster "${key}": ${error instanceof Error?error.message:String(error)}`);}
  }
  return {flat,version,warnings,unread,unresolved};
}
// The complete built-in browser cluster from Pc.builtinBrowser = kPe. These
// are flattening mappings only; downstream validation and policy remain required.
const BUILTIN_BROWSER_MAP = Object.freeze({
  enabled:'builtinBrowserEnabled',
  defaultDomainPolicy:'builtinBrowserDefaultDomainPolicy',
  allowedDomains:'builtinBrowserAllowedDomains',
  blockedDomains:'builtinBrowserBlockedDomains',
});
const BUILTIN_BROWSER_CLUSTER = Object.freeze({
  propMap:BUILTIN_BROWSER_MAP,
  flatten(value) {
    const result={};
    for(const [key,target] of Object.entries(BUILTIN_BROWSER_MAP)) if(value[key]!==undefined) result[target]=value[key];
    return result;
  },
  findUnread(value) { return Object.keys(value).filter(key=>!Object.hasOwn(BUILTIN_BROWSER_MAP,key)&&value[key]!==undefined).map(key=>`builtinBrowser.${key}`); },
});
// Pc.telemetry = RMe: all five direct leaves in this shipped build.
const TELEMETRY_MAP = Object.freeze({
  orgUuid:'deploymentOrganizationUuid',
  disableEssential:'disableEssentialTelemetry',
  disableNonessential:'disableNonessentialTelemetry',
  disableNonessentialServices:'disableNonessentialServices',
  usageMetrics:'usageMetricsEnabled',
});
const TELEMETRY_CLUSTER = Object.freeze({
  propMap:TELEMETRY_MAP,
  flatten(value) {
    const result={};
    for(const [key,target] of Object.entries(TELEMETRY_MAP)) if(value[key]!==undefined) result[target]=value[key];
    return result;
  },
  findUnread(value) { return Object.keys(value).filter(key=>!Object.hasOwn(TELEMETRY_MAP,key)&&value[key]!==undefined).map(key=>`telemetry.${key}`); },
});
module.exports={flattenBootstrap,BUILTIN_BROWSER_MAP,BUILTIN_BROWSER_CLUSTER,TELEMETRY_MAP,TELEMETRY_CLUSTER};
