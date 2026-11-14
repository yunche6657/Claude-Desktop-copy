'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createGrowthBookProvider } = require('./growthbook-provider.cjs');

// The transport and account identity belong to the mode backend. In particular,
// the inference gateway is not the desktop features control plane.
function createMainGrowthBookRuntime({ getContext, userData, providerOptions = {} }) {
  const file = path.join(userData, 'fcache');
  const provider = createGrowthBookProvider({ ...providerOptions, getContext, cache: {
    read: () => fs.readFile(file),
    write: async bytes => {
      await fs.mkdir(userData, { recursive: true });
      const temporary = `${file}.tmp-${process.pid}`;
      await fs.writeFile(temporary, bytes);
      await fs.rename(temporary, file);
    },
  } });
  let sourceWork = Promise.resolve();
  return { ...provider,
    refreshSource: () => {
      // Security consumers must await an application for this source, even
      // though ordinary sourceChanged retains native re-projection behavior.
      provider.invalidateSecurityFreshness();
      provider.sourceChanged();
      const work = provider.refresh({ force: true, requireSecurityCurrent: true });
      sourceWork = Promise.resolve(work);
      return sourceWork;
    },
    waitForSourceSettled: async () => {
      let work;
      do {
        work = sourceWork; await work;
        await provider.waitForGrowthBookSettled();
      } while (work !== sourceWork);
    },
  };
}
module.exports = { createMainGrowthBookRuntime };
