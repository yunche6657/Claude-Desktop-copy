import { fileURLToPath } from 'node:url';
// The checkout pins this directory; Store updates must not change the test target.
export const PINNED_ION_DIST = fileURLToPath(new URL('../../resources/ion-dist/', import.meta.url)).replace(/[\\/]$/, '');
