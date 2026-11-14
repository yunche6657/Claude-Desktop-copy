'use strict';

// Hn's caller must supply its current host/plugin/tenant conflict predicate.
// This module does not discover or cache those sources.
const validName = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
const uuid = /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;
const sources = new Set(['project','user','local','plugin','managed','enterprise']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sanitize = value => value.replace(/[^a-zA-Z0-9_-]/g,'_');
const key = value => sanitize(value).toLowerCase().replace(/[-_]+/g,'_');
function parts(name) {
  const clean = sanitize(name);
  return {keys:[...new Set([key(name),key(name.replace(/^plugin:/,''))])],
    read:[`${name}:`,`mcp__local_${clean}__`,`mcp__internal_${clean}__`,`mcp__${clean}__`,`mcp__remote-devices__${clean}__`]
      .map(value=>value.toLowerCase().replace(/-/g,'_')).filter(value=>value!=='mcp__remote_devices__')};
}
function ambiguous(a,b) {
  return a.keys.some(value=>b.keys.includes(value)) || a.read.some(value=>b.read.some(other=>value.startsWith(other)||other.startsWith(value)));
}
function invalidServerName(name) {
  const normalized=name.replace(/^plugin:/,'');
  return !validName.test(name)||!validName.test(normalized)||uuid.test(name)||parts(name).keys.some(value=>!/[a-z0-9]/.test(value));
}
function metadata(value) {
  if (!object(value)) return undefined;
  const result={};
  if (value.ui !== undefined) {
    if (!object(value.ui)) return undefined;
    if (value.ui.resourceUri !== undefined && (typeof value.ui.resourceUri !== 'string' || !value.ui.resourceUri.startsWith('ui://'))) return undefined;
    result.ui={...value.ui};
  } else if ('ui' in value) result.ui=undefined;
  if (value['ui/resourceUri'] !== undefined) {
    if (typeof value['ui/resourceUri'] !== 'string' || !value['ui/resourceUri'].startsWith('ui://')) return undefined;
    result['ui/resourceUri']=value['ui/resourceUri'];
  } else if ('ui/resourceUri' in value) result['ui/resourceUri']=undefined;
  return (result.ui?.resourceUri ?? result['ui/resourceUri']) !== undefined ? result : undefined;
}
function filterCliMcpApps(input, hostConflict) {
  if (typeof hostConflict !== 'function') throw new TypeError('host conflict predicate required');
  if (!Array.isArray(input)||input.length>256) return [];
  const servers=[];
  for (const server of input) {
    if (!object(server)||typeof server.name !== 'string'||server.name.length>128) return [];
    servers.push({name:server.name,source:typeof server.source==='string'?server.source:undefined,tools:Array.isArray(server.tools)?server.tools:undefined});
  }
  const names=servers.map(server=>parts(server.name)),result=[];
  for (const [index,server] of servers.entries()) {
    if (!sources.has(server.source)||invalidServerName(server.name)||hostConflict(server.name)||names.some((name,other)=>other!==index&&ambiguous(names[index],name))) continue;
    const candidates=[];
    for (const tool of server.tools ?? []) {
      if (!object(tool)||typeof tool.name!=='string') continue;
      const meta=metadata(tool._meta);
      if (meta===undefined) continue;
      candidates.push({name:tool.name,description:typeof tool.description==='string'?tool.description:undefined,_meta:meta});
    }
    const tools=candidates.slice(0,128).filter(tool=>tool.name.length<=128&&validName.test(tool.name)&&
      (tool._meta.ui?.resourceUri??'').length<=2048&&(tool._meta['ui/resourceUri']??'').length<=2048)
      .map(tool=>({name:tool.name,description:tool.description?.slice(0,1024),inputSchema:{type:'object'},_meta:tool._meta}));
    if (tools.length) result.push({name:server.name,serverSource:'cli',tools});
  }
  return result;
}
module.exports={filterCliMcpApps};
