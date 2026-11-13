import Anthropic from '@anthropic-ai/sdk';
import { apiDetail, clientOptions, keyInUse, keyProblem, keyProblemText } from '../jobs/scoring/anthropic-key.mjs';
import { modelFor, modelInfo } from '../jobs/scoring/models.mjs';
import { AssistantError } from './prompt.mjs';

const MAX_TOKENS = 16000;
const NO_USAGE = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

// The assistant on the Claude API, with the user's own key. Dayjob holds the conversation (the API keeps nothing)
// and runs the tool loop itself: each round streams a reply, runs the tools it asked for, and sends the results back.
// An application worked through in the Dayjob browser takes a few dozen rounds, so the limit on them is generous.
export function createApiEngine({ getSettings, createClient = options => new Anthropic(options), maxRounds = 80 }) {
  // conversation id -> the messages sent so far, exactly as the API returned them (thinking blocks included).
  const sessions = new Map();
  const key = () => keyInUse(getSettings().ai);

  return {
    id: 'anthropic-api',
    async status() {
      return key().apiKey ? { available: true, detail: 'Claude API' } : { available: false, detail: 'Add an Anthropic API key in Settings.' };
    },
    live: id => sessions.has(id),
    close(id) { sessions.delete(id); },
    closeAll() { sessions.clear(); },
    async send({ id, text, system, model: wanted, tools, callTool, onText, onThinking, onRound, onDiscard, signal }) {
      const using = key();
      if (!using.apiKey) throw new AssistantError('no-key', 'Add an Anthropic API key in Settings.');
      const model = modelFor('anthropic-api', wanted);
      // Every current Claude model thinks adaptively; the oldest ones in the list take no thinking setting at all.
      const adaptive = modelInfo('anthropic-api', model)?.efforts.length !== 0;
      const client = createClient(clientOptions(using, { maxRetries: 2, timeout: 10 * 60 * 1000 }));
      const session = sessions.get(id) || { messages: [] };
      sessions.set(id, session);
      const base = session.messages.length;
      session.messages.push({ role: 'user', content: text });
      const usage = NO_USAGE();
      let served = model;
      let rounds = 0;
      let badJson = 0;
      try {
        for (;;) {
          onRound();
          onThinking();
          const stream = client.messages.stream({
            model,
            max_tokens: MAX_TOKENS,
            // The prompt, the tools and the conversation so far are the same from one request to the next, so they are cached.
            cache_control: { type: 'ephemeral' },
            system,
            tools: tools.map(tool => ({ ...tool, eager_input_streaming: true })),
            ...(adaptive ? { thinking: { type: 'adaptive' } } : {}),
            messages: session.messages,
          }, { signal });
          stream.on('text', onText);
          let message;
          try { message = await stream.finalMessage(); } catch (error) {
            // With inputs streamed as they are written, one that cannot be parsed fails the round: ask again, twice at most.
            if (error instanceof Anthropic.APIError || signal?.aborted || badJson >= 2) throw error;
            badJson += 1;
            onDiscard();
            continue;
          }
          badJson = 0;
          served = message.model || served;
          usage.inputTokens += message.usage?.input_tokens || 0;
          usage.outputTokens += message.usage?.output_tokens || 0;
          usage.cacheReadTokens += message.usage?.cache_read_input_tokens || 0;
          usage.cacheWriteTokens += message.usage?.cache_creation_input_tokens || 0;
          if (message.stop_reason === 'refusal') throw new AssistantError('refusal', 'Claude declined this request.');
          session.messages.push({ role: 'assistant', content: message.content });
          if (message.stop_reason === 'pause_turn') continue;
          const calls = message.content.filter(block => block.type === 'tool_use');
          // A plain answer that ran out of room simply ends where it stopped.
          if (!calls.length) return { usage, model: served, rounds: rounds + 1 };
          // A reply cut off while writing a tool call may carry half an input: answer every call with an error instead of running any.
          const cut = message.stop_reason === 'max_tokens';
          const results = [];
          for (const call of calls) {
            if (cut || signal?.aborted) {
              results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: cut ? 'The reply was cut off before this call was complete; it was not run.' : 'The user stopped the reply; this was not run.' });
              continue;
            }
            const outcome = await callTool(call.name, call.input);
            results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, ...(outcome.ok ? {} : { is_error: true }) });
          }
          session.messages.push({ role: 'user', content: results });
          if (cut) throw new AssistantError('cut-off', 'The reply was cut off.');
          if (signal?.aborted) throw signal.reason || new Error('Stopped.');
          rounds += 1;
          if (rounds >= maxRounds) throw new AssistantError('too-many-steps', 'That took too many steps; ask again in smaller pieces.');
        }
      } catch (error) {
        // A message that got no answer at all is taken back, so the next one does not carry it along.
        if (session.messages.length === base + 1) session.messages.length = base;
        if (!session.messages.length) sessions.delete(id);
        if (signal?.aborted || error instanceof AssistantError) throw error;
        if (keyProblem(error)) throw new AssistantError(keyProblem(error), keyProblemText(keyProblem(error)));
        if (error instanceof Anthropic.RateLimitError) throw new AssistantError('rate-limit', 'The Claude API is rate limiting requests. Try again in a moment.');
        if (error instanceof Anthropic.APIConnectionError) throw new AssistantError('offline', 'Could not reach the Claude API. Check the network connection.');
        if (error instanceof Anthropic.APIError) throw new AssistantError('api', `Claude API error ${error.status}: ${apiDetail(error)}`);
        throw error;
      }
    },
  };
}
