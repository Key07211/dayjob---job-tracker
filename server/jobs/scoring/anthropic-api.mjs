import Anthropic from '@anthropic-ai/sdk';
import { effortFor, modelFor, modelInfo } from './models.mjs';
import { SCORE_SCHEMA, SYSTEM_PROMPT, buildUserPrompt, normalizeScore } from './prompt.mjs';
import { anthropicUsage } from './usage.mjs';
import { apiDetail, clientOptions, keyInUse, keyProblem, keyProblemText } from './anthropic-key.mjs';

// The request for one question. Server-side fallback is only sent to models
// that have one; at the top efforts the reply gets more room to think.
export function apiRequest({ ai, system, prompt, schema }) {
  const model = modelFor('anthropic-api', ai.model);
  const effort = effortFor('anthropic-api', model, ai.effort);
  const deep = effort === 'xhigh' || effort === 'max';
  return {
    model,
    max_tokens: deep ? 32000 : 16000,
    ...(modelInfo('anthropic-api', model)?.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    system,
    output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: prompt }],
  };
}

// Scores with the Claude API using the user's own key. Structured outputs keep
// the reply schema-valid.
export function createApiProvider({ getSettings, createClient = options => new Anthropic(options) }) {
  return {
    id: 'anthropic-api',
    status() {
      const { ai } = getSettings();
      const key = keyInUse(ai).apiKey;
      return { available: Boolean(key), detail: key ? `Claude API · ${modelFor('anthropic-api', ai.model)}` : 'Add an Anthropic API key in Settings.' };
    },
    // One prompt in, one JSON object (matching schema) out.
    async ask({ system, prompt, schema, signal }) {
      const { ai } = getSettings();
      const key = keyInUse(ai);
      if (!key.apiKey) throw new Error('No Anthropic API key is set.');
      const request = apiRequest({ ai, system, prompt, schema });
      const client = createClient(clientOptions(key, { maxRetries: 2, timeout: (request.max_tokens > 16000 ? 10 : 5) * 60 * 1000 }));
      let response;
      try {
        response = await client.beta.messages.create(request, { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        // A key and its workspace come first: the API's own words for those are no help to the person reading them.
        if (keyProblem(error)) throw new Error(keyProblemText(keyProblem(error)));
        if (error instanceof Anthropic.RateLimitError) throw new Error('The Claude API is rate limiting requests; scoring will resume on the next run.');
        if (error instanceof Anthropic.APIError) throw new Error(`Claude API error ${error.status}: ${apiDetail(error)}`);
        throw error;
      }
      if (response.stop_reason === 'refusal') throw new Error('Claude declined this request.');
      if (response.stop_reason === 'max_tokens') throw new Error('The Claude reply was cut off.');
      const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
      return { value: JSON.parse(text), provider: 'anthropic-api', model: response.model || request.model, usage: anthropicUsage(response.usage), turns: 1,
        chars: system.length + prompt.length };
    },
    async score({ resume, posting, signal }) {
      const { ai } = getSettings();
      const reply = await this.ask({ system: SYSTEM_PROMPT, prompt: buildUserPrompt({ resume, posting, language: ai.language }), schema: SCORE_SCHEMA, signal });
      return { ...normalizeScore(reply.value), provider: reply.provider, model: reply.model, usage: reply.usage, turns: reply.turns, chars: reply.chars };
    },
  };
}
