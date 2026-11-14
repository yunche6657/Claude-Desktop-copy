import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const {formatMcpError}=createRequire(import.meta.url)('../desktop/mcp-error.cjs');

test('connector errors retain the original URL-origin projection', t => {
 const source=path.resolve('..','ccd-ref','asar','.vite','build','index.chunk-lzaSYO3Q.js');
 if(!fs.existsSync(source)) return t.skip('original desktop artifact not available');
 const text=fs.readFileSync(source,'utf8');const start=text.indexOf('function eKe('),end=text.indexOf('var tKe=',start);
 assert.ok(start>=0&&end>start);const original=vm.runInNewContext(text.slice(start,end)+';eKe', {URL});
 for(const value of ['failed https://user:pass@example.test/path?token=secret#fragment', 'route 127.0.0.1 https://example.test/x', 'bad custom://host/path', 'malformed http://', 'plain error', 'ahttps://one.test/x']) {
  assert.equal(formatMcpError(value),original(value));
 }
 assert.equal(formatMcpError(new Error('failed https://u:p@example.test/private?token=x')), 'failed https://example.test');
});
