// Unified diff generation.
//
// The diff view is what makes an edit reviewable before it is applied, so this
// module has to be exact about three things: what changed, where, and whether
// the hunk boundaries are stable. It implements the standard Myers shortest
// edit script over lines, then renders the familiar unified format
// (`@@ -a,b +c,d @@`) that the Code view shows.
//
// Deliberate limits, because a wrong diff is worse than no diff:
//   * line-based only; no intra-line highlighting;
//   * a hard cap on compared lines, reported as `truncated` rather than silently
//     producing a partial answer;
//   * no trailing-newline guessing: whether the source ended with "\n" is
//     recorded per side.
'use strict';

const DEFAULT_CONTEXT = 3;
const MAX_LINES = 20000;

/** Splits into lines without dropping a trailing empty line's information. */
function splitLines(text) {
  if (text === '') return { lines: [], endsWithNewline: false };
  const endsWithNewline = text.endsWith('\n');
  const body = endsWithNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), endsWithNewline };
}

/**
 * Myers diff. Returns a list of [type, oldIndex, newIndex] where type is
 * 'equal' | 'delete' | 'insert'.
 */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];

  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    // Snapshot of v before this round, which the backtrack needs.
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const kIndex = k + offset;
      let x;
      if (k === -d || (k !== d && v[kIndex - 1] < v[kIndex + 1])) {
        x = v[kIndex + 1];
      } else {
        x = v[kIndex - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[kIndex] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return backtrack(trace, a, b, max, offset);
}

function backtrack(trace, a, b, dFinal, offset) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = dFinal; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['equal', x - 1, y - 1]); x--; y--; }
    if (d > 0) {
      if (x === prevX) { ops.push(['insert', -1, y - 1]); y--; }
      else { ops.push(['delete', x - 1, -1]); x--; }
    }
  }
  while (x > 0 && y > 0) { ops.push(['equal', x - 1, y - 1]); x--; y--; }
  while (x > 0) { ops.push(['delete', x - 1, -1]); x--; }
  while (y > 0) { ops.push(['insert', -1, y - 1]); y--; }
  return ops.reverse();
}

/**
 * Builds unified-diff hunks.
 * Returns { hunks, truncated, added, removed }.
 */
function buildHunks(oldLines, newLines, context = DEFAULT_CONTEXT) {
  const ops = myers(oldLines, newLines);

  // Indices in `ops` that are not 'equal'.
  const changed = [];
  for (let i = 0; i < ops.length; i++) if (ops[i][0] !== 'equal') changed.push(i);
  if (changed.length === 0) {
    return { hunks: [], truncated: false, added: 0, removed: 0 };
  }

  // Merge changes into groups whose context windows overlap.
  const groups = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (let i = 1; i < changed.length; i++) {
    const nextStart = Math.max(0, changed[i] - context);
    if (nextStart <= end + 1) {
      end = Math.min(ops.length - 1, changed[i] + context);
    } else {
      groups.push([start, end]);
      start = nextStart;
      end = Math.min(ops.length - 1, changed[i] + context);
    }
  }
  groups.push([start, end]);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op[0] === 'insert') added++;
    if (op[0] === 'delete') removed++;
  }

  const hunks = groups.map(([from, to]) => {
    const lines = [];
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;

    for (let i = from; i <= to; i++) {
      const [type, oldIndex, newIndex] = ops[i];
      if (type === 'equal') {
        if (!oldStart) { oldStart = oldIndex + 1; newStart = newIndex + 1; }
        lines.push({ type: 'context', text: oldLines[oldIndex] });
        oldCount++; newCount++;
      } else if (type === 'delete') {
        if (!oldStart) { oldStart = oldIndex + 1; newStart = newIndex + 1 || 1; }
        lines.push({ type: 'del', text: oldLines[oldIndex] });
        oldCount++;
      } else {
        if (!oldStart) { oldStart = oldIndex + 1 || 1; newStart = newIndex + 1; }
        lines.push({ type: 'add', text: newLines[newIndex] });
        newCount++;
      }
    }
    // A pure insertion at the very top has no old line to anchor on.
    if (!oldStart) oldStart = 1;
    if (!newStart) newStart = 1;
    return { oldStart, oldCount, newStart, newCount, lines };
  });

  return { hunks, truncated: false, added, removed };
}

/**
 * Diffs two strings. Never throws on size; instead reports `truncated`.
 */
function diffText(oldText, newText, { context = DEFAULT_CONTEXT } = {}) {
  const before = splitLines(oldText ?? '');
  const after = splitLines(newText ?? '');

  if (before.lines.length > MAX_LINES || after.lines.length > MAX_LINES) {
    return {
      hunks: [],
      truncated: true,
      added: 0,
      removed: 0,
      reason: `file exceeds the ${MAX_LINES}-line diff limit`,
      oldEndsWithNewline: before.endsWithNewline,
      newEndsWithNewline: after.endsWithNewline,
    };
  }

  const result = buildHunks(before.lines, after.lines, context);
  return {
    ...result,
    oldEndsWithNewline: before.endsWithNewline,
    newEndsWithNewline: after.endsWithNewline,
  };
}

/** Renders hunks as the text form, mainly for tests and logs. */
function formatUnified(filePath, diff) {
  if (diff.truncated) return `diff ${filePath}: ${diff.reason}`;
  if (!diff.hunks.length) return '';
  const out = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const hunk of diff.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      out.push(prefix + line.text);
    }
  }
  return out.join('\n');
}

module.exports = { diffText, formatUnified, splitLines, myers, buildHunks, DEFAULT_CONTEXT, MAX_LINES };
