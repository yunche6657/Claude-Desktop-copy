'use strict';
// One-shot stdio bridge; it exposes no host control methods.
const net=require('node:net');
const [pipe,envKey]=process.argv.slice(2);if(!pipe||!/^CCD_MCP_RELAY_[A-F0-9]{40}$/.test(envKey||''))process.exit(1);
const secret=process.env[envKey];for(const key of Object.keys(process.env))if(/^CCD_MCP_RELAY_/i.test(key))delete process.env[key];if(!/^[a-f0-9]{64}$/.test(secret||''))process.exit(1);
const socket=net.createConnection(pipe);socket.once('connect',()=>{socket.write(secret+'\n');process.stdin.pipe(socket);socket.pipe(process.stdout)});
socket.once('error',()=>process.exit(1));socket.once('close',()=>process.exit(0));process.stdin.once('end',()=>socket.end());
