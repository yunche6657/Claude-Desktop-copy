'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateGatewayRuntimeConfig} = require('../desktop/gateway-runtime-settings.cjs');
const MAX_BYTES = 65536;
function readDeploymentRuntime(root) {
  const source=path.join(root,'.data','gateway-runtime.json');
  if(!fs.existsSync(source))return null;
  if(!fs.statSync(source).isFile()||fs.statSync(source).size>MAX_BYTES)throw new Error('Invalid deployment gateway runtime file');
  let parsed;try{parsed=JSON.parse(fs.readFileSync(source,'utf8'));}catch{throw new Error('Malformed deployment gateway runtime configuration');}
  const rules=validateGatewayRuntimeConfig(parsed);
  const bytes=Buffer.from(JSON.stringify({version:1,rules},null,2)+'\n');
  if(bytes.length>MAX_BYTES)throw new Error('Deployment gateway runtime configuration exceeds size limit');
  return{bytes,rules,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
function stageDeploymentRuntime(root,out) {
  const config=readDeploymentRuntime(root);if(!config)return null;
  const destination=path.join(out,'resources','gateway-runtime.json');fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,config.bytes);
  return{file:'resources/gateway-runtime.json',rules:config.rules.length,sha256:config.sha256,credentialsBundled:false};
}
function verifyDeploymentRuntime(root,out) {
  const expected=readDeploymentRuntime(root),file=path.join(out,'resources','gateway-runtime.json');
  if(!expected){if(fs.existsSync(file))throw new Error('Unexpected deployment gateway runtime configuration');return null;}
  const actual=fs.readFileSync(file);
  if(crypto.createHash('sha256').update(actual).digest('hex')!==expected.sha256)throw new Error('Deployment gateway runtime mismatch');
  return {rules:expected.rules.length,sha256:expected.sha256,credentialsBundled:false};
}
module.exports={readDeploymentRuntime,stageDeploymentRuntime,verifyDeploymentRuntime};
