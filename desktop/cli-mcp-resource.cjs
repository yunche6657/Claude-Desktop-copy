'use strict';

// Original IA measures the JSON string's UTF-16 code units, before metadata
// filtering; this is not a UTF-8 byte limit. The caller owns actor identity,
// current-query and announced-server/URI checks before invoking read().
const LIMIT=10485760;
const failed=()=>({contents:[],unavailable:'read_failed'});
const object=value=>value!==null&&typeof value==='object'&&Object.prototype.toString.call(value)==='[object Object]';
function filterCliMcpMetadata(meta,cliRunsAsThisUser=false) {
  if (!object(meta)) return {};
  const result={};
  if (meta.ui!==null && typeof meta.ui==='object') {
    result.ui=Object.fromEntries(Object.entries(meta.ui).filter(([key])=>key==='resourceUri'||key==='visibility'||key==='prefersBorder'||(cliRunsAsThisUser&&key==='csp')));
  }
  if (meta['ui/resourceUri']!==undefined) result['ui/resourceUri']=meta['ui/resourceUri'];
  return result;
}
function parseCliMcpResourceReply(reply,cliRunsAsThisUser=false) {
  if (!object(reply)||!Array.isArray(reply.contents)) return failed();
  const contents=[];
  for (const item of reply.contents) {
    if (!object(item)||typeof item.uri!=='string') return failed();
    for (const key of ['mimeType','text','blob']) if (item[key]!==undefined&&typeof item[key]!=='string') return failed();
    if (item._meta!==undefined&&!object(item._meta)) return failed();
    const output={uri:item.uri};
    for (const key of ['mimeType','text','blob','_meta']) if (key in item) output[key]=item[key];
    contents.push(output);
  }
  try {
    if (JSON.stringify(contents).length>LIMIT) return failed();
    return {contents:contents.map(({_meta,...item})=>({...item,..._meta&&{_meta:filterCliMcpMetadata(_meta,cliRunsAsThisUser)}}))};
  } catch { return failed(); }
}
async function readCliMcpResource({uri,serverName,read,track=promise=>promise,cliRunsAsThisUser=false}={}) {
  if (typeof uri!=='string'||!uri.startsWith('ui://')) return failed();
  if (typeof read!=='function'||typeof track!=='function') throw new TypeError('read and track must be functions');
  let timer;
  try {
    const timeoutMarker=Symbol('deadline');
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(timeoutMarker),30000);timer.unref?.();});
    const promise=Promise.race([Promise.resolve(read(serverName,uri)),timeout]);
    const result=await track(promise);
    return result===timeoutMarker?failed():parseCliMcpResourceReply(result,cliRunsAsThisUser);
  } catch { return failed(); }
  finally { clearTimeout(timer); }
}
module.exports={filterCliMcpMetadata,parseCliMcpResourceReply,readCliMcpResource};
