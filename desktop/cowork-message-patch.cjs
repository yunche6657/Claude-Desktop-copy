'use strict';
function patchCoworkMessages(text) {
  const before='if(n.uuid){if(Hi.current.has(n.uuid))return;Hi.current.add(n.uuid)}';
  const after='if(n.uuid){if(Hi.current.has(n.uuid)){if(n.type==="assistant"&&n.message){Ae(rows=>rows.map(row=>row.uuid===n.uuid?{...row,...n}:row));}return;}Hi.current.add(n.uuid)}';
  if (!text.includes(before)) return null;
  const append='Ae(e=>[...e,{...n,receivedStreamAt:t}])';
  if (!text.includes(append)) return null;
  const ordered='Ae(e=>[...e,{...n,receivedStreamAt:t}].sort((a,b)=>{const x=Date.parse(a.timestamp),y=Date.parse(b.timestamp);return Number.isFinite(x)&&Number.isFinite(y)?x-y:0}))';
  const registration='await xa(i,()=>{e===0&&m.stamp("mcp_first_client"),e+=1})';
  if(!text.includes(registration))return null;
  const nonBlocking='void xa(i,()=>{e===0&&m.stamp("mcp_first_client"),e+=1}).catch(()=>{})';
  return {text:text.replace(before,after).replace(append,ordered).replace(registration,nonBlocking),changed:true};
}
module.exports={patchCoworkMessages};
