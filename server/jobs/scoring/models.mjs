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
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', efforts: UP_TO_MAX, fallback: true, tag: 'top' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: UP_TO_MAX, fallback: true },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: UP_TO_MAX, tag: 'fast' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', efforts: UP_TO_MAX, fallback: true, tag: 'older' },
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

// One score asked for with its own provider, model or effort (the MCP tool can), without touching Settings: what
// that call uses. Anything left out is as in Settings, except that another provider than the one in Settings starts
// from its own default model, since the model in Settings belongs to the other. -> null when nothing was asked
// for, { provider, model, effort } otherwise. Throws (with what would do) on a value that cannot be used.
export function scoringChoice(ai, { provider, model, effort } = {}) {
  const asked = value => value !== undefined && value !== null && value !== '';
  if (![provider, model, effort].some(asked)) return null;
  const refuse = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (asked(provider) && !PROVIDER_IDS.includes(provider)) refuse(`provider must be one of: ${PROVIDER_IDS.join(', ')}.`);
  const chosen = asked(provider) ? provider : PROVIDER_IDS.includes(ai.provider) ? ai.provider : 'claude-cli';
  if (asked(model) && (typeof model !== 'string' || model.length > 100 || !/^[\w.:[\]-]+$/.test(model))) refuse('model must be a model id such as claude-opus-5-5.');
  const { family, models } = PROVIDERS[chosen];
  // A model of the other family can only fail; one that is in no list (a newer one) is let through.
  const other = asked(model) && [...CLAUDE_MODELS, ...OPENAI_MODELS].some(item => item.id === model) && !models.some(item => item.id === model);
  if (other) refuse(`${model} is not a model of ${chosen} (${family === 'claude' ? 'Claude' : 'OpenAI'} models: ${models.map(item => item.id).join(', ')}).`);
  const useModel = asked(model) ? model : chosen === ai.provider ? ai.model || '' : '';
  if (asked(effort) && !EFFORTS.includes(effort)) refuse(`effort must be one of: ${EFFORTS.join(', ')}.`);
  const info = modelInfo(chosen, useModel);
  if (asked(effort) && info && !info.efforts.includes(effort)) {
    refuse(info.efforts.length ? `${info.id} takes these efforts: ${info.efforts.join(', ')}.` : `${info.id} takes no effort setting; leave effort out.`);
  }
  return { provider: chosen, model: useModel, effort: asked(effort) ? effort : effortFor(chosen, useModel, ai.effort || '') };
}

// The effort to send: '' means the model's own default. A level the model
// does not accept falls back to the default instead of failing every score.
export function effortFor(provider, model, effort) {
  if (!effort) return '';
  const info = modelInfo(provider, model);
  if (!info) return effort;
  return info.efforts.includes(effort) ? effort : '';
}
