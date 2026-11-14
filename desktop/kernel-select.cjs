// Which agent kernel does this launch use, and why.
//
// The V6 plan (evidence/v6-worklist.md §0) introduces a second backend: a
// claude-code-best (CCB) child process driven over stream-json. Introducing a second
// kernel introduces a new failure mode that the project has already been burned by:
// a component silently degrades and every downstream symptom is attributed to the wrong
// layer. So selection is explicit and *reportable*:
//
//   - it is a pure function of a small, injected description of the environment;
//   - it never throws because a kernel is missing — it returns the fallback plus the
//     reason the preferred one was rejected;
//   - the reason is meant to be surfaced in the UI and in logs, so "we are on the local
//     kernel" is a fact the user can read, not an inference from odd behaviour.
//
// This module decides only. It does not spawn anything and does not import either
// backend, which keeps it testable without a 115 MB runtime on disk.
'use strict';

const KERNEL_IDS = Object.freeze({ LOCAL: 'local', CCB: 'ccb' });

/**
 * @typedef {{
 *   id: string,
 *   available: boolean,
 *   reason?: string | null,
 * }} KernelAvailability
 */

/** Normalises one probe result so a half-filled object cannot produce a "maybe". */
function normaliseProbe(id, probe) {
  const available = Boolean(probe && probe.available);
  return {
    id,
    available,
    reason: available ? null : String((probe && probe.reason) || 'unavailable'),
  };
}

/**
 * Choose a kernel.
 *
 * Policy: an explicitly requested kernel wins if it is available; otherwise fall back to
 * the local one. The preference order is {"ccb", "local"} when nothing is requested,
 * because the whole point of V6 is the richer tool set — but only when CCB actually
 * probes as available.
 *
 * @param {{
 *   requested?: string | null,           // CLAUDE_AGENT_KERNEL or a settings value
 *   probes?: KernelAvailability[],       // one entry per backend, produced by the caller
 *   fallbackId?: string,
 * }} input
 * @returns {{
 *   id: string,
 *   requested: string | null,
 *   fellBack: boolean,
 *   reason: string,
 *   probes: KernelAvailability[],
 * }}
 */
function selectKernel({ requested = null, probes = [], fallbackId = KERNEL_IDS.LOCAL } = {}) {
  // Dedupe by id, first one wins. Two probes for the same kernel would otherwise make the
  // report ambiguous ("ccb: available; ccb: unavailable") and let list order decide the
  // outcome, which is exactly the kind of accidental behaviour this module exists to avoid.
  const seenIds = new Set();
  const normalised = [];
  for (const probe of Array.isArray(probes) ? probes : []) {
    if (!probe || typeof probe.id !== 'string' || !probe.id) continue;
    if (seenIds.has(probe.id)) continue;
    seenIds.add(probe.id);
    normalised.push(normaliseProbe(probe.id, probe));
  }

  const byId = new Map(normalised.map((probe) => [probe.id, probe]));
  const wanted = typeof requested === 'string' && requested.trim() ? requested.trim() : null;

  if (wanted) {
    const probe = byId.get(wanted);
    if (probe && probe.available) {
      return { id: wanted, requested: wanted, fellBack: false, reason: `${wanted} selected (requested)`, probes: normalised };
    }
    const why = probe ? probe.reason : 'not one of the known kernels';
    // Refusing to start because a preference cannot be met would be a worse outcome than
    // running on the kernel that does work, provided the substitution is announced.
    const fallback = byId.get(fallbackId);
    const fallbackOk = Boolean(fallback && fallback.available);
    return {
      id: fallbackOk ? fallbackId : null,
      requested: wanted,
      fellBack: true,
      reason: fallbackOk
        ? `${wanted} requested but unavailable (${why}); using ${fallbackId}`
        : `${wanted} requested but unavailable (${why}); no fallback available`,
      probes: normalised,
    };
  }

  for (const candidate of [KERNEL_IDS.CCB, KERNEL_IDS.LOCAL]) {
    const probe = byId.get(candidate);
    if (probe && probe.available) {
      const others = normalised.filter((other) => other.id !== candidate && !other.available)
        .map((other) => `${other.id}: ${other.reason}`);
      return {
        id: candidate,
        requested: null,
        fellBack: candidate !== KERNEL_IDS.CCB,
        reason: others.length
          ? `${candidate} selected by default (${others.join('; ')})`
          : `${candidate} selected by default`,
        probes: normalised,
      };
    }
  }

  return {
    id: null,
    requested: null,
    fellBack: false,
    reason: 'no kernel is available: ' + (normalised.map((probe) => `${probe.id}: ${probe.reason}`).join('; ') || 'nothing probed'),
    probes: normalised,
  };
}

/**
 * Describe whether the CCB kernel can run here, without spawning it.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   exists?: (file: string) => boolean,
 *   root?: string,          // project root, for the default agent-core/ paths
 *   path?: {join: (...parts: string[]) => string},
 * }} input
 */
function probeCcb({
  env = {},
  // Default to the real filesystem. Defaulting to a stub that answers "no" made the probe
  // un-passable unless a caller remembered to inject something, so the first wiring test that
  // used it without `exists` reported "CCB unavailable" on a checkout where both files were
  // present. A probe whose default answer is "absent" cannot distinguish absent from unwired.
  exists = (file) => require('node:fs').existsSync(file),
  root = require('./ccb-runtime-paths.cjs').resolveAgentRoot(),
  path = require('node:path'),
} = {}) {
  const bun = env.CCB_BUN || path.join(root, 'agent-core', 'bun', 'bun.exe');
  const entry = env.CCB_ENTRY || path.join(root, 'agent-core', 'claude-code', 'dist', 'cli-bun.js');

  const missing = [];
  if (!exists(bun)) missing.push(`bun runtime not found at ${bun}`);
  if (!exists(entry)) missing.push(`kernel bundle not found at ${entry}`);
  if (env.CCB_DISABLE === '1') missing.push('CCB_DISABLE=1');
  if (missing.length) return { id: KERNEL_IDS.CCB, available: false, reason: missing.join('; ') };
  return { id: KERNEL_IDS.CCB, available: true, reason: null, bun, entry };
}

/** The local kernel needs only the agent runner, which the main process always builds. */
function probeLocal({ hasAgent = true } = {}) {
  return hasAgent
    ? { id: KERNEL_IDS.LOCAL, available: true, reason: null }
    : { id: KERNEL_IDS.LOCAL, available: false, reason: 'no agent runner configured' };
}

module.exports = { KERNEL_IDS, selectKernel, probeCcb, probeLocal, normaliseProbe };
