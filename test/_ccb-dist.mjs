// Shared locator for tests that read the vendored CCB bundle.
//
// WHY THIS EXISTS
//   The bundle's chunk filenames are content hashes chosen by the bundler. They are stable for a
//   given build but NOT across builds: re-adopting a build of the same pinned source produced
//   chunk-6s1e8f7y.js where the previous tree had chunk-9nsdvmt2.js, with identical module
//   content. Three test files had hardcoded old filenames (field-gap-r394, field-matrix-r395,
//   workflow-contract-4b-r388) and broke the moment a fresh build was adopted — not because the
//   findings changed, but because the tests identified files by name.
//
//   A test that pins a filename is testing the bundler, not the finding. These helpers locate a
//   chunk by a marker string that only that chunk contains, so the assertion survives a rebuild.
//
// USAGE
//   import { findChunk, readChunk, DIST, haveDist } from './_ccb-dist.mjs';
//   const text = readChunk('function getAllBaseTools()');   // the tool table
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(ROOT, 'agent-core', 'claude-code', 'dist');

// Skip the multi-megabyte bundled vendor blobs when scanning: they are not tool sources and
// scanning them for every marker would dominate the run.
const MAX_SCAN_BYTES = 20_000_000;

export function haveDist() {
  return fs.existsSync(path.join(DIST, 'cli-bun.js'));
}

function chunks() {
  return fs.readdirSync(DIST).filter((n) => n.endsWith('.js'));
}

/**
 * The chunk file whose text contains `marker`.
 *
 * Requires the marker to be UNIQUE across the bundle, because "first file that contains this
 * string" is not a stable identity: measured, `createWorkflowToolCore` appears in THREE chunks
 * (the table's import binding, a re-export, and the chunk that actually defines it), and the
 * first match was a stub whose `isEnabled` is `() => true`. A test reading that chunk asserted
 * against the wrong module and failed for a reason unrelated to its own subject.
 *
 * Pass `{ allowMany: true }` only when any occurrence is genuinely equivalent.
 */
export function findChunk(marker, { allowMany = false } = {}) {
  const hits = [];
  const seen = [];
  for (const name of chunks()) {
    const full = path.join(DIST, name);
    if (fs.statSync(full).size > MAX_SCAN_BYTES) continue;
    const text = fs.readFileSync(full, 'utf8');
    seen.push(name);
    if (text.includes(marker)) hits.push({ name, text });
  }
  if (!hits.length) {
    throw new Error('no chunk in the vendored dist contains ' + JSON.stringify(marker)
      + ' (searched ' + seen.length + ' .js files). The bundle was rebuilt or the marker moved; '
      + 're-derive it from the source tree rather than guessing.');
  }
  if (hits.length > 1 && !allowMany) {
    throw new Error(JSON.stringify(marker) + ' appears in ' + hits.length + ' chunks ('
      + hits.map((h) => h.name).join(', ') + '). Pick a marker that identifies one definition, '
      + 'or pass { allowMany: true } if every occurrence is equivalent.');
  }
  return { name: hits[0].name, text: hits[0].text };
}

/** Text of the chunk containing `marker`. */
export function readChunk(marker, options) {
  return findChunk(marker, options).text;
}

/**
 * The chunk that declares `const <id> = buildTool(` for a given tool identifier.
 *
 * Tools are spread across chunks and the table chunk only re-exports some of them, so callers
 * that need a tool's own schema cannot assume one file.
 */
export function findToolChunk(toolIdentifier) {
  return findChunk(toolIdentifier + ' = buildTool(');
}
