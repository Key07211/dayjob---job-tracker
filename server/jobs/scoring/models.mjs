// The models offered under Resume & AI for each provider, and the reasoning
// efforts each one accepts. The settings screen reads this file too.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const UP_TO_MAX = EFFORTS;
const NO_XHIGH = ['low', 'medium', 'high', 'max'];
const UP_TO_XHIGH = ['low', 'medium', 'high', 'xhigh'];
const UP_TO_HIGH = ['low', 'medium', 'high'];

// fallback: the Claude API may retry a declined request on another model.
// tag: recommended | top | fast | older, shown next to the name.
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: UP_TO_MAX, fallback: true, tag: 'recommended' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', efforts: UP_TO_MAX, fallback: true, tag: 'top' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: UP_TO_MAX, fallback: true },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: UP_TO_MAX, tag: 'fast' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', efforts: UP_TO_MAX, fallback: true, tag: 'older' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', efforts: UP_TO_MAX, fallback: true, tag: 'older' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', efforts: UP_TO_MAX, tag: 'older' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', efforts: UP_TO_MAX, tag: 'older' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', efforts: UP_TO_MAX, tag: 'older' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', efforts: NO_XHIGH, tag: 'older' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', efforts: NO_XHIGH, tag: 'older' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', efforts: [], tag: 'older' },
];

// What Codex offers with a ChatGPT sign-in; Free and Go plans get GPT-6 Luna only.
export const CODEX_MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: UP_TO_MAX, tag: 'recommended' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: UP_TO_MAX, tag: 'top' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: UP_TO_MAX },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: UP_TO_MAX, tag: 'fast' },
];

export const OPENAI_MODELS = [
  ...CODEX_MODELS,
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', efforts: UP_TO_XHIGH, tag: 'older' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: UP_TO_XHIGH, tag: 'older' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: UP_TO_XHIGH, tag: 'older' },
  { id: 'gpt-5.5', name: 'GPT-5.5', efforts: UP_TO_XHIGH, tag: 'older' },
  { id: 'gpt-5-mini', name: 'GPT-5 mini', efforts: UP_TO_HIGH, tag: 'older' },
];

// defaultModel '' leaves the choice to the CLI's own setting.
export const PROVIDERS = {
  'claude-cli': { family: 'claude', models: CLAUDE_MODELS, defaultModel: '' },
  'anthropic-api': { family: 'claude', models: CLAUDE_MODELS, defaultModel: 'claude-opus-5-5' },
  'codex-cli': { family: 'openai', models: CODEX_MODELS, defaultModel: '' },
  'openai-api': { family: 'openai', models: OPENAI_MODELS, defaultModel: 'gpt-6.1-sol' },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const modelFor = (provider, model) => model || PROVIDERS[provider]?.defaultModel || '';

// The catalog entry, or null for a typed-in id or the CLI's default model.
export function modelInfo(provider, model) {
  const id = modelFor(provider, model);
  return [...CLAUDE_MODELS, ...OPENAI_MODELS].find(item => item.id === id) || null;
}

// The effort to send: '' means the model's own default. A level the model
// does not accept falls back to the default instead of failing every score.
export function effortFor(provider, model, effort) {
  if (!effort) return '';
  const info = modelInfo(provider, model);
  if (!info) return effort;
  return info.efforts.includes(effort) ? effort : '';
}
