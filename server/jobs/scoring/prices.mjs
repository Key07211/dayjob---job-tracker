// What a call costs, from the list prices the services publish: US dollars for a million tokens.
// Read on 2026-11-13 from https://platform.claude.com/docs/en/about-claude/pricing and
// https://developers.openai.com/api/docs/pricing (standard tier). Prices change; PRICES_AS_OF is shown beside every sum.
//
//   input   input that was not read from a cache
//   read    input read from a cache
//   write   input written to a cache (the 5-minute kind, the only one Dayjob asks for)
//   output  everything the model wrote, its thinking included
//   long    the prices of a call whose whole prompt is over `over` tokens
export const PRICES_AS_OF = '2026-11-13';

// The engines that bill a key for every token. Claude Code and Codex run on a subscription instead: what their calls
// would have cost is worked out the same way, but it is shown as a reference, never counted as money spent.
export const METERED = ['anthropic-api', 'openai-api'];
export const KEY_SERVICE = { 'anthropic-api': 'anthropic', 'openai-api': 'openai' };

const claude = (input, output, read) => ({ input, output, read, write: input * 1.25 });
const gpt = (input, output, read, long) => ({ input, output, read, write: 0, long: long ? { over: 272000, write: 0, ...long } : undefined });
const PRICES = {
  'claude-fable-5-2': claude(8, 40, 0.2),
  'claude-fable-5-1': claude(10, 50, 0.25),
  'claude-fable-5': claude(10, 50, 1),
  'claude-opus-5-5': claude(4, 20, 0.2),
  'claude-opus-5': claude(5, 25, 0.5),
  'claude-opus-4-8': claude(5, 25, 0.5),
  'claude-opus-4-7': claude(5, 25, 0.5),
  'claude-opus-4-6': claude(5, 25, 0.5),
  'claude-opus-4-5': claude(5, 25, 0.5),
  'claude-sonnet-5-5': claude(2, 10, 0.1),
  'claude-sonnet-5': claude(2, 10, 0.2),
  'claude-sonnet-4-6': claude(3, 15, 0.3),
  'claude-sonnet-4-5': claude(3, 15, 0.3),
  'claude-haiku-5-5': { ...claude(0.1, 0.5, 0.01), long: { over: 100000, ...claude(0.5, 2.5, 0.05) } },
  'claude-haiku-4-5': claude(1, 5, 0.1),
  'gpt-6.1-sol': gpt(2, 10, 0.1, { input: 4, output: 15, read: 0.2 }),
  'gpt-6-astra': gpt(10, 50, 1, { input: 20, output: 75, read: 2 }),
  'gpt-6-sol': gpt(2, 10, 0.2, { input: 4, output: 15, read: 0.4 }),
  'gpt-6-luna': gpt(0.1, 0.5, 0.01, { input: 0.2, output: 0.75, read: 0.02 }),
  'gpt-5.6-sol': gpt(4, 20, 0.4, { input: 8, output: 30, read: 0.8 }),
  'gpt-5.6-terra': gpt(2, 12, 0.2, { input: 4, output: 18, read: 0.4 }),
  'gpt-5.6-luna': gpt(0.2, 1.2, 0.02, { input: 0.4, output: 1.8, read: 0.04 }),
  'gpt-5.5': gpt(5, 30, 0.5, { input: 10, output: 45, read: 1 }),
  'gpt-5-mini': gpt(0.25, 2, 0.025),
};
const IDS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

// The price list entry for a model as an engine names it: a dated snapshot ("claude-haiku-4-5-20251001") and
// Claude Code's "[1m]" mark count as the model they are; the longest id that fits wins.
export function priceOf(model) {
  const name = String(model || '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  if (!name) return null;
  const id = IDS.find(known => name === known || name.startsWith(`${known}-`));
  return id ? PRICES[id] : null;
}

// Dollars for one logged call, or null when the model has no known price or the call did not report tokens.
// A call of several turns is priced by the size of its average prompt.
export function costOf(model, usage, turns = 1) {
  const price = priceOf(model);
  if (!price || !usage) return null;
  const n = key => Math.max(0, Number(usage[key]) || 0);
  const prompt = (n('inputTokens') + n('cacheReadTokens') + n('cacheWriteTokens')) / Math.max(1, Number(turns) || 1);
  const at = price.long && prompt > price.long.over ? price.long : price;
  return (n('inputTokens') * at.input + n('cacheReadTokens') * at.read + n('cacheWriteTokens') * at.write + n('outputTokens') * at.output) / 1e6;
}
