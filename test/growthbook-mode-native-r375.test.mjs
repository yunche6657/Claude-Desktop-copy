import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
const require=createRequire(import.meta.url);
const {hybridEnabled}=require('../desktop/growthbook-mode-backend.cjs');
const source=readFileSync(resolve('../ccd-ref/asar/.vite/build/index.chunk-lzaSYO3Q.js'),'utf8');
function fragment(start,end) {const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b)}
const code=fragment('function ZCe(', 'var So=')+fragment('function MTe(', 'function NTe(')+fragment('function Ol(', 'function iBe(');
const native=runInNewContext(`${code}; kl`,{URL,ns:e=>!!e.bootstrap?.url&&e.bootstrap?.enabled!==false,Yze:new Set(['api.anthropic.com','api-staging.anthropic.com','api.claude.ai']),rBe:()=>undefined});
const urls=[
 'https://api.anthropic.com/v1/a', 'https://api.anthropic.com:444/v1/a',
 'https://name@api.anthropic.com/v1/a', 'https://api.anthropic.com\\evil/path',
 'https:\\\\api.anthropic.com\\evil/path', 'https:\\api.anthropic.com\\evil/path',
 'https:api.anthropic.com\\evil/path', 'https:\t//api.anthropic.com\\evil/path',
 ' https://api.claude.ai/path ', 'https://api.claude.ai/path\\ok',
 'https://api.claude.ai%40evil.example/', 'https://api.claude.ai.evil.example/',
];
test('original extracted ZCe/MTe/Ol/kl match mode backend URL authority behavior',()=>{
 const differences=[];
 for(const url of urls){const bootstrap={url};const expected=native({bootstrap}),actual=hybridEnabled(bootstrap);if(expected!==actual)differences.push({url,expected,actual});}
 assert.deepEqual(differences,[]);
});
