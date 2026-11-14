'use strict';
const g = require('node:net');
const { parseHost } = require('./native-public-suffix.cjs');
// Pure native host/address helpers. Source offsets and hashes are in round360-access/origin-policy-provenance.json.

// Native metadata @563098..563682
var sEe=["metadata.google.internal","metadata.goog","metadata","instance-data","instance-data.ec2.internal"],cEe=["169.254.169.254","169.254.170.2","169.254.170.23","169.254.0.23","169.254.42.42","100.100.100.200","100.96.0.96","100.80.80.80","168.63.129.16","192.0.0.192"],lEe=["[fd00:ec2::254]","[fd00:ec2::23]","[fd00:a9fe:a9fe::1]","[fe80::a9fe:a9fe]"];function uEe(e){let[t,n,r,i]=e.split(".").map(Number);return`[::ffff:${(t<<8|n).toString(16)}:${(r<<8|i).toString(16)}]`}var ms=new Set([...sEe,...cEe,...cEe.map(uEe),...lEe]),dEe=new Set(sEe),fEe=new Set(cEe),pEe=new Set(lEe);

// Native ipAliases @2123319..2124360
function WGt(e){let t=(0,g.isIP)(e);if(t!==0)try{return new URL(t===6?`http://[${e}]`:`http://${e}`).hostname}catch{return}}var Yb="([0-9a-f]{1,4})",GGt=RegExp(`^\\[(?:::ffff|64:ff9b:):${Yb}:${Yb}\\]$`),KGt=RegExp(`^\\[64:ff9b:1(?::[0-9a-f]{0,4})*:${Yb}:${Yb}\\]$`),qGt=RegExp(`^\\[64:ff9b:1(?::[0-9a-f]{1,4})?::${Yb}:${Yb}\\]$`);function JGt(e,t){return`${e>>8}.${e&255}.${t>>8}.${t&255}`}function YGt(e){let t=GGt.exec(e)??KGt.exec(e);if(t)return{dotted:JGt(parseInt(t[1],16),parseInt(t[2],16)),certain:!e.startsWith("[64:ff9b:1:")||qGt.test(e)}}var XGt=[[RegExp(`^\\[::(?:ffff:0:)?${Yb}:${Yb}\\]$`),0],[RegExp(`^\\[2002:${Yb}:${Yb}:`),0],[RegExp(`(?:::|:0:|:200:)5efe:${Yb}:${Yb}\\]$`),0],[RegExp(`^\\[2001:0:${Yb}:${Yb}:`),0],[RegExp(`^\\[2001:(?:0:|:)(?:[0-9a-f:]*:)?${Yb}:${Yb}\\]$`),65535]];function ZGt(e){let t=Xb(e);return t?.concat(XGt.flatMap((([e,n])=>{let[,r,i]=e.exec(t[0])??[];return r&&i?[JGt(parseInt(r,16)^n,parseInt(i,16)^n)]:[]})))}function Xb(e){let t=WGt(e);if(t===void 0)return;let n=YGt(t);return n?[t,n.dotted]:[t]}

// Native publicAddress @2447165..2448968
var u9t=[["0.0.0.0",8,"This-network (RFC 1122 \xa73.2.1.3)"],["10.0.0.0",8,"Private-Use (RFC 1918)"],["100.64.0.0",10,"Shared Address Space / CGNAT (RFC 6598)"],["127.0.0.0",8,"Loopback (RFC 1122 \xa73.2.1.3)"],["168.63.129.16",32,"Azure WireServer / IMDS virtual IP (public-range, Azure-VNet-only)"],["169.254.0.0",16,"Link-Local (RFC 3927); incl. cloud metadata 169.254.169.254"],["172.16.0.0",12,"Private-Use (RFC 1918)"],["192.0.0.0",24,"IETF Protocol Assignments (RFC 6890 \xa72.1)"],["192.168.0.0",16,"Private-Use (RFC 1918)"],["224.0.0.0",4,"Multicast (RFC 5771) \u2014 SSDP/mDNS discovery lives here"],["240.0.0.0",4,"Reserved (RFC 1112 \xa74) incl. 255.255.255.255 limited broadcast"]];function d9t(e){let[t=0,n=0,r=0,i=0]=e.split(".").map(Number);return`${(t<<8|n).toString(16)}:${(r<<8|i).toString(16)}`}var f9t=(()=>{let e=new g.BlockList;for(let[t,n]of u9t)e.addSubnet(t,n,"ipv4"),e.addSubnet(`::ffff:${t}`,96+n,"ipv6"),e.addSubnet(`2002:${d9t(t)}::`,16+n,"ipv6");return e.addSubnet("::",96,"ipv6"),e.addSubnet("::ffff:0:0:0",96,"ipv6"),e.addSubnet("64:ff9b::",96,"ipv6"),e.addSubnet("64:ff9b:1::",48,"ipv6"),e.addSubnet("2001::",32,"ipv6"),e.addSubnet("fc00::",7,"ipv6"),e.addSubnet("fe80::",10,"ipv6"),e.addSubnet("fec0::",10,"ipv6"),e})(),p9t=/(?:^|\.)(?:localhost|local|internal|localdomain|lan|intranet|home\.arpa|test|example|invalid)$/i,m9t=new Set(["ip6-localhost","ip6-loopback"]);function fw(e){for(let t of[e,`[${e}]`])try{return new URL(`http://${t}`).hostname}catch{}return null}function pw(e){let t=fw(e);if(t===null)return!1;let n=t.replace(/^\[|\]$/g,""),r=n.replace(/\.+$/,"");if(r!==n&&(r=(fw(r)??r).replace(/^\[|\]$/g,"")),r.length===0)return!1;let i=(0,g.isIP)(r);return i===4?!f9t.check(r,"ipv4"):i===6?!f9t.check(r,"ipv6"):!(m9t.has(r)||!r.includes(".")||p9t.test(r))}

// Native loopbackNames @3115707..3115827
function cN(e){return e==="localhost"||e.endsWith(".localhost")||e==="127.0.0.1"||e==="0.0.0.0"||e==="::1"||e==="[::1]"}

// Native loopbackAliases @3115977..3116165
function HBn(e){let t=e.replace(/\.+$/,"");return e!==t&&cN(t)||/^127\.\d+\.\d+\.\d+$/.test(e)&&e!=="127.0.0.1"?!0:e.startsWith("[::ffff:")}function uN(e){return dN(e)||HBn(e)||e==="[::]"}

// Native loopbackFilter @3116396..3116702
function dN(e){return cN(e)||/^127(\.\d{1,3}){1,3}$/.test(e)}function WBn(e){let t=/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(e);if(t===null)return!1;let n=parseInt(t[1],16),r=parseInt(t[2],16);return(n&65280)==32512||n===0&&r===0}function fN(e){return uN(e)&&(!e.startsWith("[::ffff:")||WBn(e))}

// Native Do/fwn/mwn/AVn host policy semantics, using the shipped static suffix table.
function parseHostPattern(entry){
  if(typeof entry!=='string')return null;let host=entry,port;const colon=entry.lastIndexOf(':');
  if(colon!==-1){const value=entry.slice(colon+1);if(!/^[1-9][0-9]{0,4}$/.test(value)||Number(value)>65535)return null;port=Number(value);host=entry.slice(0,colon);}
  if(host==='*')return port===undefined?{host}:null;
  const suffix=host.startsWith('*.')?host.slice(2):host;
  if(host!=='localhost'&&(!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(suffix)||!suffix.includes('.')))return null;
  return{host:host.toLowerCase(),...(port!==undefined?{port}:{})};
}
function hasRegistrableDomain(host){return parseHost(host).domain!==null&&parseHost('x.'+host).domain!==null;}
function hostMatches(host,entry,port,{siteMode=null}={}){
  const pattern=parseHostPattern(entry);if(!pattern||pattern.port!==undefined&&pattern.port!==port)return false;
  const candidate=host.toLowerCase(),base=pattern.host,wildcard=base.startsWith('*.');
  if(base==='*')return siteMode===null||siteMode==='deny';
  if(wildcard&&siteMode==='allow'&&!hasRegistrableDomain(base.slice(2)))return false;
  if(wildcard)return !g.isIP(candidate)&&candidate.endsWith(base.slice(1));
  if(candidate===base)return true;
  if(siteMode===null)return false;
  const strip=value=>value.startsWith('www.')?value.slice(4):value;
  return strip(candidate)===strip(base)&&(siteMode==='deny'||hasRegistrableDomain(strip(base)));
}
function nonPublicHost(host,interfaces=[]){
  const bare=host.replace(/^\[|\]$/g,'');
  if(ms.has(host)||(ZGt(bare)||[]).some(alias=>ms.has(alias)))return 'metadata';
  const own=new Set(interfaces.flatMap(address=>Xb(String(address).split('%')[0])||[]));
  if(pw(host))return (Xb(bare)||[]).some(alias=>own.has(alias))?'private-ip':null;
  return g.isIP(bare)===0?'private-name':'private-ip';
}
function hostPolicyVerdict(policy,url,interfaces=[]){
  if(policy==null)return null;
  const target=new URL(url),host=target.hostname.replace(/\.+$/,''),port=target.port?Number(target.port):target.protocol==='https:'?443:80;
  const egress=Array.isArray(policy.egress)?policy.egress:[];
  if(egress.some(row=>!Array.isArray(row)||!row.some(entry=>hostMatches(host,entry,port))))return 'block';
  const allow=Array.isArray(policy.allow)?policy.allow:[],deny=Array.isArray(policy.deny)?policy.deny:[];
  if(policy.mode==='block')return allow.some(entry=>hostMatches(host,entry,port,{siteMode:'allow'}))?'allow':'block';
  if(deny.some(entry=>hostMatches(host,entry,port,{siteMode:'deny'}))||egress.length===0&&deny.length>0&&g.isIP(host.replace(/^\[|\]$/g,''))!==0&&nonPublicHost(host,interfaces)===null)return 'block';
  return null;
}
function buildBuiltinBrowserHostPolicy({enabled=false,pendingServed=false,sitePolicyUnstamped=false,
  defaultDomainPolicy='allow',allowedDomains=[],blockedDomains=[],egress=[]}={}){
  if(enabled!==true||pendingServed||sitePolicyUnstamped)return{mode:'block',allow:[],deny:[],egress:[]};
  return{mode:defaultDomainPolicy==='block'?'block':'allow',allow:Array.isArray(allowedDomains)?[...allowedDomains]:[],deny:Array.isArray(blockedDomains)?[...blockedDomains]:[],
    egress:Array.isArray(egress)?egress.filter(row=>Array.isArray(row)&&!row.includes('*')).map(row=>[...row]):[]};
}
function derivePreviewPolicy({managedConfig={},managedSettings=managedConfig,managedStatus='ready',preferences={},
  featureGates={},builtinBrowserEnabled,pendingServed=false,admissionBlocked=false,epoch=0}={}){
  const config=managedConfig&&typeof managedConfig==='object'?managedConfig:{};
  const managed=managedSettings&&typeof managedSettings==='object'&&!Array.isArray(managedSettings)?managedSettings:null;
  const prefs=preferences&&typeof preferences==='object'?preferences:{};
  const available=managedStatus==='ready'&&managed!==null;
  const setting=managed?.browserExternalPageTools;
  const externalBrowsingDisabled=typeof setting==='string'&&['disable','disabled'].includes(setting.toLowerCase());
  const externalNavigationDisabled=managed?.disableBrowserExternalNavigation===true;
  const gate=featureGates?.['17519066'];
  let flag=typeof gate==='boolean'?gate:typeof gate?.on==='boolean'?gate.on:typeof gate?.defaultValue==='boolean'?gate.defaultValue:undefined;
  let gateSource=flag===undefined?'absent':'feature-map';
  const deployment=config.deploymentMode||'3p';
  const builtin=builtinBrowserEnabled??config.builtinBrowserEnabled??config.builtinBrowser?.enabled??false;
  if(flag===undefined&&deployment==='3p'){flag=builtin===true&&!pendingServed;gateSource='3p-builtinBrowserEnabled';}
  const coworkGate=featureGates?.['3990395613'];
  let coworkFlag=typeof coworkGate==='boolean'?coworkGate:typeof coworkGate?.on==='boolean'?coworkGate.on:typeof coworkGate?.defaultValue==='boolean'?coworkGate.defaultValue:undefined;
  if(coworkFlag===undefined&&deployment==='3p')coworkFlag=builtin===true&&!pendingServed;
  const userToolsEnabled=prefs.coworkBrowserToolsEnabled!==false;
  const baseAvailable=available&&flag===true&&!externalNavigationDisabled&&!admissionBlocked;
  return{available,externalBrowsingDisabled,externalNavigationDisabled,userToolsEnabled,
    browserFeatureEnabled:baseAvailable&&userToolsEnabled,
    coworkBrowserAvailable:baseAvailable&&coworkFlag===true,coworkBrowserEnabled:baseAvailable&&coworkFlag===true&&userToolsEnabled,
    coworkBrowserFeatureGate:coworkFlag===true,
    featureGate:flag===true,gateSource,builtinBrowserEnabled:builtin===true,epoch};
}
function createPreviewOriginPolicy({getHostPolicy=()=>null,authenticatesHostedSiteCheck=false,
  getInterfaceAddresses=()=>Object.values(require('node:os').networkInterfaces()).flatMap(rows=>(rows||[]).map(row=>row.address)),
  hostedSiteCheck=null}={}){
  let disposed=false,epoch=0;
  async function classifyOrigin(value){
    if(disposed)return{kind:'error',reason:'disposed'};
    let url;try{url=new URL(value);}catch{return{kind:'error',reason:'invalid_url'};}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return{kind:'error',reason:'non_http_or_credentialed_url'};
    const captured=epoch,host=url.hostname;
    // Native PN returns null for loopback spellings, so zN returns category0 before a hosted lookup.
    if(fN(host))return{kind:'ok',category:'category0'};
    const normalized=host.replace(/\.+$/,'');
    let interfaces,policy;try{interfaces=await getInterfaceAddresses();policy=await getHostPolicy();}catch{return{kind:'error',reason:'local_policy_unavailable'};}
    if(disposed||captured!==epoch)return{kind:'epoch-changed'};
    if(hostPolicyVerdict(policy,url.href,interfaces)==='block')return{kind:'ok',category:'category_org_blocked'};
    const local=nonPublicHost(normalized,interfaces);
    if(local==='metadata')return{kind:'ok',category:'category1'};
    if(local==='private-ip')return{kind:'ok',category:'category3',privateNetworkOnly:true};
    // Native BVn skips the hosted lookup for a 3p private-name floor when unauthenticated.
    if(local==='private-name'&&authenticatesHostedSiteCheck===false)return{kind:'ok',category:'category3',privateNetworkOnly:true};
    if(typeof hostedSiteCheck!=='function')return{kind:'error',reason:'hosted_site_check_required'};
    try{
      const response=await hostedSiteCheck(url.href,{host:normalized,fullUrl:true,authenticatesHostedSiteCheck});
      if(disposed||captured!==epoch)return{kind:'epoch-changed'};
      if(!response||!['category0','category1','category2','category3','category_org_blocked'].includes(response.category))return{kind:'error',reason:'bad_hosted_category'};
      if(response.category==='category_org_blocked')return{kind:'ok',category:response.category,...(response.policySource?{policySource:response.policySource}:{})};
      const high=['category1','category2'].includes(response.category);
      if(local==='private-name'&&!high)return{kind:'ok',category:'category3',privateNetworkOnly:true};
      const verdict=hostPolicyVerdict(policy,url.href,interfaces);
      const category=verdict==='allow'&&response.category==='category3'?'category0':response.category;
      return{kind:'ok',category,...(response.policySource?{policySource:response.policySource}:{})};
    }catch{return{kind:'error',reason:'hosted_site_check_failed'};}
  }
  return{classifyOrigin,invalidate(){epoch++;},dispose(){disposed=true;epoch++;}};
}
module.exports={derivePreviewPolicy,buildBuiltinBrowserHostPolicy,createPreviewOriginPolicy,hostPolicyVerdict,parseHostPattern,nonPublicHost};
