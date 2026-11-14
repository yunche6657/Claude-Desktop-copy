'use strict';
// Metadata, schema traversal and stable serialization are supplied by the host.
// This does not assert that a particular registry or serializer is native-equivalent.
function createConsentTargetExtractor({consentKeys,allKeys,isFailClosed,isUrlField,nestedPaths,formerLabel,serialize}={}) {
  for(const fn of [consentKeys,allKeys,isFailClosed,isUrlField,nestedPaths,formerLabel,serialize]) if(typeof fn!=='function')throw new TypeError('all consent registry dependencies are required');
  const valueOf=value=>typeof value==='string'?value:serialize(value);
  function extractObject(entry,paths) {
    const out={};
    for(const path of paths) {const value=path.split('.').reduce((value,key)=>value?.[key],entry);if(value!==undefined)out[path]=value;}
    return out;
  }
  return function extract(config) {
    const result=[];
    for(const key of consentKeys()) {
      const value=config[key],empty=Array.isArray(value)&&value.length===0;
      if(value!==undefined&&!empty&&!isFailClosed(key,value)) {
        const origin=typeof value==='string'&&isUrlField(key)?new URL(value).origin:undefined;
        const alias=formerLabel(key);
        result.push({label:key,value:valueOf(value),key,origin,...alias===undefined?{}:{formerLabels:[alias]}});
      }
    }
    for(const key of allKeys()) {
      const value=config[key];if(typeof value!=='object'||!value)continue;
      const paths=nestedPaths(key);if(paths.size===0)continue;
      if(!Array.isArray(value)) {
        const selected=extractObject(value,paths),subfields=Object.keys(selected);
        if(subfields.length)result.push({label:key,value:valueOf(selected),key,subfields});
        continue;
      }
      const counts=new Map();
      for(const [index,entry] of value.entries()) {
        const id=[entry.name,entry.repo,entry.url].find(value=>typeof value==='string');
        const selected=extractObject(entry,paths);if(!Object.keys(selected).length)continue;
        const base=`${key}[${id??index}]`,count=(counts.get(base)??0)+1;counts.set(base,count);
        result.push({label:count===1?base:`${base}#${count}`,value:valueOf(selected),key,entryIndex:index,entryId:id});
      }
    }
    return result;
  };
}
module.exports={createConsentTargetExtractor};
