'use strict';
const fs = require('node:fs');
const path = require('node:path');
// The window-size marker belongs to the Electron store, not desktop config.
// This operation owns only this key and preserves the rest of the JSON object.
function deleteWindowSignedInFlag(userData, log = () => {}) {
  const file = path.join(userData, 'config.json');
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid window store');
  } catch (error) { if (error.code !== 'ENOENT') log('window marker read failed'); return; }
  if (!Object.hasOwn(value, 'windowSizeWasSignedIn')) return;
  delete value.windowSizeWasSignedIn;
  const temporary = file + '.window-reset-' + process.pid;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8'); fs.renameSync(temporary, file); }
  catch { log('window marker write failed'); try { fs.unlinkSync(temporary); } catch {} }
}
module.exports = { deleteWindowSignedInFlag };
