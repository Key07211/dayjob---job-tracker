import Anthropic from '@anthropic-ai/sdk';
import { SCORE_SCHEMA, SYSTEM_PROMPT, buildUserPrompt, normalizeScore } from './prompt.mjs';

export const DEFAULT_API_MODEL = 'claude-opus-5-5';

// Scores with the Claude API using the user's own key. Structured outputs keep
// the reply schema-valid; server-side fallback retries a declined request.
export function createApiProvider({ getSettings, createClient = options => new Anthropic(options) }) {
  return {
    id: 'anthropic-api',
    status() {
      const { ai } = getSettings();
      const key = ai.apiKey || process.env.ANTHROPIC_API_KEY;
      return { available: Boolean(key), detail: key ? `Claude API · ${ai.model || DEFAULT_API_MODEL}` : 'Add an Anthropic API key in Settings.' };
    },
    // One prompt in, one JSON object (matching schema) out.
    async ask({ system, prompt, schema, signal }) {
      const { ai } = getSettings();
      const apiKey = ai.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('No Anthropic API key is set.');
      const model = ai.model || DEFAULT_API_MODEL;
      const client = createClient({ apiKey, maxRetries: 2, timeout: 5 * 60 * 1000 });
      let response;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system,
          output_config: { effort: ai.effort || 'medium', format: { type: 'json_schema', schema } },
          messages: [{ role: 'user', content: prompt }],
        }, { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof Anthropic.AuthenticationError) throw new Error('The Anthropic API key was rejected.');
        if (error instanceof Anthropic.RateLimitError) throw new Error('The Claude API is rate limiting requests; scoring will resume on the next run.');
        if (error instanceof Anthropic.APIError) throw new Error(`Claude API error ${error.status}: ${error.message}`);
        throw error;
      }
      if (response.stop_reason === 'refusal') throw new Error('Claude declined this request.');
      if (response.stop_reason === 'max_tokens') throw new Error('The Claude reply was cut off.');
      const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
      return { value: JSON.parse(text), provider: 'anthropic-api', model: response.model || model };
    },
    async score({ resume, posting, signal }) {
      const { ai } = getSettings();
      const reply = await this.ask({ system: SYSTEM_PROMPT, prompt: buildUserPrompt({ resume, posting, language: ai.language }), schema: SCORE_SCHEMA, signal });
      return { ...normalizeScore(reply.value), provider: reply.provider, model: reply.model };
    },
  };
}
