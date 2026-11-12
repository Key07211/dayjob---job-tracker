// What one AI call used, in one shape for every provider:
// { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }.
// inputTokens is the input that was not read from a cache, so the whole input
// is the sum of the three input numbers. null means the provider did not say.
const known = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const count = value => (known(value) && Number(value) > 0 ? Math.round(Number(value)) : 0);

export function anthropicUsage(usage) {
  if (!usage || !known(usage.input_tokens)) return null;
  return { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens), cacheWriteTokens: count(usage.cache_creation_input_tokens) };
}

// Claude Code's result envelope. modelUsage lists every model the call used
// (camelCase keys); usage, in the API's own shape, is the fallback.
export function claudeCodeUsage(envelope) {
  const models = Object.values(envelope?.modelUsage || {}).filter(item => item && typeof item === 'object' && known(item.inputTokens));
  if (!models.length) return anthropicUsage(envelope?.usage);
  const sum = key => models.reduce((total, item) => total + count(item[key]), 0);
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadInputTokens'), cacheWriteTokens: sum('cacheCreationInputTokens') };
}

// The Responses API counts cached tokens inside input_tokens.
export function openAiUsage(usage) {
  if (!usage || !known(usage.input_tokens)) return null;
  const cached = Math.min(count(usage.input_tokens), count(usage.input_tokens_details?.cached_tokens));
  return { inputTokens: count(usage.input_tokens) - cached, outputTokens: count(usage.output_tokens), cacheReadTokens: cached, cacheWriteTokens: 0 };
}
