// Reading a CLI .jsonl transcript into renderer rows.
//
// Kept out of the bridge so it can be tested directly: the parent chain it produces is
// what the renderer uses to lay a conversation out, and getting it wrong is invisible in
// the store (the rows are all there) while the session appears to lose its messages.
'use strict';

const fs = require('node:fs');

/**
 * Read one CLI .jsonl transcript into renderer rows. Never throws.
 *
 * A CLI transcript is JSONL: one record per line, each with a `type`. Only `user` and
 * `assistant` rows carry a message; queue-operation / attribution-snapshot rows are noise.
 *
 * The renderer walks `parentUuid` from the head to build the conversation; it does not lay
 * rows out by array order. Two things break that, both repaired here:
 *
 *   1. The field must be carried over at all. Dropping it made every imported row an
 *      orphan, so an imported session opened showing only its first message — measured on
 *      the live replica: 4 rows stored, 1 rendered.
 *   2. A link may point at a row that was filtered out above, which leaves the row
 *      unreachable. Measured on this host: 141 of 478 rows in one transcript.
 *
 * So a link is used only when its target is a row that was kept; otherwise the row hangs
 * off the previous kept row, which preserves reading order.
 *
 * @param {string} file
 * @returns {Array<object>}
 */
function readCliTranscript(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  const keptUuids = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || (record.type !== 'user' && record.type !== 'assistant')) continue;
    if (!record.message || !record.message.content) continue;
    const previous = rows.length ? rows[rows.length - 1].uuid : null;
    const claimed = typeof record.parentUuid === 'string' && record.parentUuid ? record.parentUuid : null;
    const parentUuid = claimed && keptUuids.has(claimed) ? claimed : previous;
    keptUuids.add(record.uuid);
    rows.push({
      parentUuid: rows.length ? parentUuid : null,
      isSidechain: record.isSidechain === true,
      ...(typeof record.promptId === 'string' && record.promptId ? { promptId: record.promptId } : {}),
      type: record.type,
      uuid: record.uuid,
      timestamp: record.timestamp,
      message: { role: record.message.role || record.type, content: record.message.content },
    });
  }
  return rows;
}

module.exports = { readCliTranscript };
