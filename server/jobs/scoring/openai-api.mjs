import { effortFor, modelFor } from './models.mjs';
import { SCORE_SCHEMA, SYSTEM_PROMPT, buildUserPrompt, normalizeScore } from './prompt.mjs';

const ENDPOINT = 'https://api.openai.com/v1/responses';

// One Responses API request. Strict structured outputs keep the reply
// schema-valid; nothing is stored on OpenAI's side.
export function openAiRequest({ ai, system, prompt, schema }) {
  const model = modelFor('openai-api', ai.model);
  const effort = effortFor('openai-api', model, ai.effort);
  return {
    model,
    instructions: system,
    input: prompt,
    store: false,
    max_output_tokens: effort === 'xhigh' || effort === 'max' ? 32000 : 16000,
    ...(effort ? { reasoning: { effort } } : {}),
    text: { format: { type: 'json_schema', name: 'reply', schema, strict: true } },
  };
}

// The reply text, or why there is none.
export function openAiReply(data) {
  const parts = (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []);
  if (parts.some(part => part.type === 'refusal')) throw new Error('The model declined this request.');
  if (data.status === 'incomplete') throw new Error('The AI reply was cut off.');
  const text = parts.filter(part => part.type === 'output_text').map(part => part.text).join('');
  if (!text) throw new Error('The AI reply did not contain JSON.');
  return text;
}

// Scores with the OpenAI API using the user's own key, billed by usage.
export function createOpenAiProvider({ getSettings, fetch = globalThis.fetch, timeoutMs = 10 * 60 * 1000 }) {
  const keyOf = ai => ai.openaiApiKey || process.env.OPENAI_API_KEY;
  return {
    id: 'openai-api',
    status() {
      const { ai } = getSettings();
      const key = keyOf(ai);
      return { available: Boolean(key), detail: key ? `OpenAI API · ${modelFor('openai-api', ai.model)}` : 'Add an OpenAI API key in Settings.' };
    },
    // One prompt in, one JSON object (matching schema) out.
    async ask({ system, prompt, schema, signal }) {
      const { ai } = getSettings();
      const apiKey = keyOf(ai);
      if (!apiKey) throw new Error('No OpenAI API key is set.');
      const request = openAiRequest({ ai, system, prompt, schema });
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) throw new Error('The OpenAI API key was rejected.');
        if (response.status === 429) throw new Error('The OpenAI API is rate limiting requests; scoring will resume on the next run.');
        throw new Error(`OpenAI API error ${response.status}: ${String(data.error?.message || response.statusText || 'no detail').slice(0, 300)}`);
      }
      return { value: JSON.parse(openAiReply(data)), provider: 'openai-api', model: data.model || request.model };
    },
    async score({ resume, posting, signal }) {
      const { ai } = getSettings();
      const reply = await this.ask({ system: SYSTEM_PROMPT, prompt: buildUserPrompt({ resume, posting, language: ai.language }), schema: SCORE_SCHEMA, signal });
      return { ...normalizeScore(reply.value), provider: reply.provider, model: reply.model };
    },
  };
}
