'use strict';
// Audited subset of the shipped flat managed-config schema. This parser does not
// flatten nested clusters or implement the complete iLe intake/consent pipeline.
const FIELD_METADATA = Object.freeze({
  builtinBrowserDefaultDomainPolicy: Object.freeze({ type:'enum', values:Object.freeze(['allow','block']), failClosedValue:'block', remotePolicy:Object.freeze({hybrid:Object.freeze({derived:true}),hotApplied:true}) }),
  deploymentOrganizationUuid: Object.freeze({ type:'string', remotePolicy:Object.freeze({hybrid:Object.freeze({derived:true}),applyUnverified:true}) }),
  disableNonessentialServices: Object.freeze({ failClosedValue:true }),
  builtinBrowserAllowedDomains: Object.freeze({type:'domains',listKind:'allowed',failClosedValue:Object.freeze([]),remotePolicy:Object.freeze({hybrid:Object.freeze({derived:true}),hotApplied:true})}),
  builtinBrowserBlockedDomains: Object.freeze({type:'domains',listKind:'blocked',failClosedValue:Object.freeze(['*']),remotePolicy:Object.freeze({hybrid:Object.freeze({derived:true}),hotApplied:true})}),
  builtinBrowserEnabled: Object.freeze({ remotePolicy: Object.freeze({hybrid:Object.freeze({derived:true})}) }),
  disableEssentialTelemetry: Object.freeze({ failClosedValue:true, remotePolicy:Object.freeze({default:true,applyUnverified:true}) }),
  disableNonessentialTelemetry: Object.freeze({ failClosedValue:true, remotePolicy:Object.freeze({default:true,applyUnverified:true}) }),
  keepAwakeEnabled: Object.freeze({ failClosedValue:false, remotePolicy:Object.freeze({hotApplied:true}) }),
  usageMetricsEnabled: Object.freeze({ remotePolicy:Object.freeze({hybrid:Object.freeze({scope:'only',derived:true}),hotApplied:true}) }),
});
function parseBoolean(value) {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== 'string') return undefined;
  const normalized=value.trim().replace(/\r/g,'').toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
}
function domainEntry(kind,value) {
  if (typeof value !== 'string' || value === '' || kind === 'allowed' && value === '*') return 'drop';
  let host=value; const colon=value.lastIndexOf(':');
  if (colon!==-1) { const port=value.slice(colon+1); if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port)>65535) return 'unknown'; host=value.slice(0,colon); }
  if(host==='*') return colon===-1 ? undefined : 'unknown';
  const h=host.startsWith('*.')?host.slice(2):host;
  if (!(h==='localhost' || /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(h)&&h.includes('.'))) return 'unknown';
  if (h.toLowerCase()==='localhost') return 'unknown';
}
function parseStructured(value) {
  if(typeof value!=='string')return value;
  try{return JSON.parse(value)}catch{try{return JSON.parse(value.replace(/\\(?!["\\/bfnrtu])/g,'\\\\'))}catch{return value}}
}
function parseBootstrapSchema(input) {
  const config = {}, errors = [], unsupported = [], stoodIn = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {config,errors,unsupported,stoodIn};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(FIELD_METADATA,key)) { unsupported.push(key); continue; }
    const value=input[key];
    if (value == null || value === '') continue;
    const meta=FIELD_METADATA[key];
    if(meta.type==='domains') {
      const raw=parseStructured(value);
      if(!Array.isArray(raw)) {errors.push({key,kind:'invalid-domains'});config[key]=[...meta.failClosedValue];stoodIn.push(key);continue;}
      const parsed=[];
      for(const item of raw) {const result=domainEntry(meta.listKind,item);if(result)errors.push({key,kind:result});if(result!=='drop')parsed.push(item);}
      if(raw.length>0&&parsed.length===0){errors.push({key,kind:'invalid-domains'});config[key]=[...meta.failClosedValue];stoodIn.push(key);}else config[key]=parsed;
      continue;
    }
    const parsed=meta.type==='string' ? (typeof value==='string'?value:undefined) : meta.type==='enum' ? (meta.values.includes(value)?value:undefined) : parseBoolean(value);
    if (parsed !== undefined) config[key]=parsed;
    else {
      errors.push({key,kind:meta.type ? `invalid-${meta.type}` : 'invalid-boolean'});
      if (Object.hasOwn(meta,'failClosedValue')) { config[key]=meta.failClosedValue; stoodIn.push(key); }
    }
  }
  return {config,errors,unsupported,stoodIn};
}
module.exports = {FIELD_METADATA,parseBoolean,parseBootstrapSchema};
