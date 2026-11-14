'use strict';

function transcriptUsage(entries) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const reported = new Map();
  const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const fields = { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadInputTokens: 'cache_read_input_tokens', cacheCreationInputTokens: 'cache_creation_input_tokens' };
  const accountedTurns = new Set((entries || []).filter(entry => entry?.ccdTurnUsage && entry.ccdUsageTurnId).map(entry => entry.ccdUsageTurnId));
  for (const entry of entries || []) {
    const message = entry?.message;
    const turnAccounted = accountedTurns.has(entry?.ccdUsageTurnId);
    const usage = entry?.type === 'assistant' && (turnAccounted ? entry.ccdTurnUsage : message?.usage);
    if (!usage || !Object.values(fields).some(field => typeof usage[field] === 'number')) continue;
    // CCB emits one assistant row per block with the same API message ID.
    const id = turnAccounted ? `turn:${entry.ccdUsageTurnId}` : message.id || entry.uuid || entry;
    const previous = reported.get(id) || {};
    for (const [field, key] of Object.entries(fields)) previous[field] = Math.max(previous[field] || 0, count(usage[key]));
    reported.set(id, previous);
  }
  if (reported.size) {
    for (const usage of reported.values()) for (const field of Object.keys(fields)) totals[field] += usage[field];
  } else {
    // Legacy transcripts without provider usage retain the previous text estimate.
    for (const entry of entries || []) {
      const content = entry?.message?.content;
      const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      totals[entry?.type === 'assistant' ? 'outputTokens' : 'inputTokens'] += Math.ceil((text || '').length / 4);
    }
  }
  return { ...totals, cacheReadTokens: totals.cacheReadInputTokens, cacheWriteTokens: totals.cacheCreationInputTokens };
}

module.exports = { transcriptUsage };
