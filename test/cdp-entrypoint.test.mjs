// Importing a suffix-named caller must not start the helper's command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';

const run = promisify(execFile);
const helper = new URL('../tools/cdp.mjs', import.meta.url);

test('shot-cdp.mjs may import the helper without evaluating its output filename', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-entry-'));
  try {
    const caller = path.join(tmp, 'shot-cdp.mjs');
    fs.writeFileSync(caller, `import ${JSON.stringify(helper.href)}; console.log('IMPORTED');`);
    const result = await run(process.execPath, [caller, 'evidence/live/proof.png'], { timeout: 5000 });
    assert.equal(result.stdout.trim(), 'IMPORTED');
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('executing cdp.mjs directly still lists targets from its configured endpoint', async () => {
  const targets = [{ id: 'proof', type: 'page', url: 'app://localhost/' }];
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/json/list');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(targets));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { stdout } = await run(process.execPath, [fileURLToPath(helper)], {
      timeout: 5000,
      env: { ...process.env, CDP_ENDPOINT: `http://127.0.0.1:${server.address().port}` },
    });
    assert.deepEqual(JSON.parse(stdout), targets);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
