'use strict';

// Keep raw totals across partial usage frames: cached tokens often arrive last.
function createOpenAIUsageUpdater(target) {
  let totalInput, cacheRead, cacheWrite;
  const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const first = (...values) => values.map(count).find(value => value !== undefined);
  return usage => {
    if (!usage || typeof usage !== 'object') return;
    const input = first(usage.prompt_tokens, usage.input_tokens);
    const output = first(usage.completion_tokens, usage.output_tokens);
    const read = first(usage.cache_read_input_tokens, usage.prompt_tokens_details?.cached_tokens, usage.input_tokens_details?.cached_tokens, usage.prompt_cache_hit_tokens);
    const write = first(usage.cache_creation_input_tokens, usage.prompt_tokens_details?.cache_write_tokens, usage.input_tokens_details?.cache_write_tokens);
    if (input !== undefined) totalInput = input;
    if (read !== undefined) cacheRead = read;
    if (write !== undefined) cacheWrite = write;
    if (output !== undefined) target.output_tokens = output;
    // OpenAI input includes cache reads/writes; Anthropic input excludes them.
    const readTokens = Math.min(cacheRead ?? 0, totalInput ?? cacheRead ?? 0);
    const writeTokens = Math.min(cacheWrite ?? 0, Math.max(0, (totalInput ?? cacheWrite ?? 0) - readTokens));
    if (totalInput !== undefined) target.input_tokens = Math.max(0, totalInput - readTokens - writeTokens);
    if (cacheRead !== undefined) target.cache_read_input_tokens = readTokens;
    if (cacheWrite !== undefined) target.cache_creation_input_tokens = writeTokens;
  };
}

module.exports = { createOpenAIUsageUpdater };
