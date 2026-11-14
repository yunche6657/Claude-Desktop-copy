'use strict';

// Test-only preload. Keep every helper (including Node's test workers) off the
// interactive Windows desktop. NODE_OPTIONS propagates this to nested Node runs.
if (process.platform === 'win32') {
  const cp = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
    const original = cp[name];
    const wrapper = function (...args) {
      const index = name === 'exec' || name === 'execSync'
        ? 1 : (Array.isArray(args[1]) || (args[1] == null && args.length > 2) ? 2 : 1);
      const options = args[index];
      const hidden = { ...(options && typeof options === 'object' ? options : {}), windowsHide: true };
      if (typeof options === 'function') args.splice(index, 0, hidden);
      else args[index] = hidden;
      return Reflect.apply(original, this, args);
    };
    // A plain function assignment silently dropped util.promisify.custom, and promisify() then
    // fell back to its generic contract-callback path. MEASURED: under this preload
    //
    //   const run = promisify(execFile)
    //   Object.keys(await run(node, ['-e','console.log(1)']))   ->  ['0','1']
    //   that object's .stdout                                  ->  undefined
    //
    // so every test that read `result.stdout` saw undefined and failed with
    // "Cannot read properties of undefined (reading 'trim')" — the tests looked broken while the
    // product was fine. Copying the original's own properties (which include the promisify
    // symbol) restores the documented { stdout, stderr } shape.
    for (const key of Reflect.ownKeys(original)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue;
      try {
        Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key));
      } catch { /* non-configurable: leave it off rather than fail the whole preload */ }
    }
    cp[name] = wrapper;
  }
  // ESM named imports must see the same wrappers as CommonJS callers.
  require('node:module').syncBuiltinESMExports();
}
