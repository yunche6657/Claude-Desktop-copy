// Cowork VM service client.
//
// The shipped main process talks to a Windows service over a named pipe:
//
//   const lDn = "\\\\.\\pipe\\cowork-vm-service"
//   uEn(lDn, { connectTimeoutMs, onSocketCreated })
//
// and frames messages with a 4-byte length prefix (see the `Uk` class in the
// shipped bundle: it buffers chunks and only yields once `buffered >= 4`).
//
// The service is `CoworkVMService`, installed by the MSIX package at
// `<resources>/cowork-svc.exe`, registered as an automatic Windows service.
// Its presence is what the frontend's `secureVm` gate actually depends on — not
// the Windows Virtual Machine Platform directly.
//
// This module reports whether that service is reachable, which is the honest
// answer to "can Cowork run tasks on this computer".
'use strict';

const net = require('node:net');
const fs = require('node:fs');

const PIPE_PATH = '\\\\.\\pipe\\cowork-vm-service';

/**
 * Probe the VM service pipe.
 * @param {{ pipePath?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ reachable: boolean, pipePath: string, detail: string }>}
 */
function probeVmService({ pipePath = PIPE_PATH, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection(pipePath);
    let settled = false;
    const done = (reachable, detail) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve({ reachable, pipePath, detail });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, 'connected'));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (error) => done(false, error && error.code ? error.code : String(error && error.message)));
  });
}

/**
 * Whether the service binary is present next to the frontend resources. This is a
 * cheaper signal than the pipe and stays true even when the service is stopped.
 * @param {string} resourcesPath
 */
function serviceBinaryPresent(resourcesPath) {
  try { return fs.existsSync(require('node:path').join(resourcesPath, 'cowork-svc.exe')); }
  catch { return false; }
}

/**
 * Whether a VM bundle has been materialised under userData. The bundle holds
 * rootfs.vhdx / vmlinuz / initrd / smol-bin.vhdx plus a `.cowork-adopted` marker.
 * @param {string} userDataPath
 */
function bundlePresent(userDataPath) {
  const dir = require('node:path').join(userDataPath, 'vm_bundles', 'claudevm.bundle');
  try {
    return {
      present: fs.existsSync(require('node:path').join(dir, 'rootfs.vhdx')),
      dir,
      adopted: fs.existsSync(require('node:path').join(dir, '.cowork-adopted')),
    };
  } catch {
    return { present: false, dir, adopted: false };
  }
}

/** Frame a JSON message with the 4-byte length prefix the service expects. */
function frameJson(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

module.exports = { PIPE_PATH, probeVmService, serviceBinaryPresent, bundlePresent, frameJson };
