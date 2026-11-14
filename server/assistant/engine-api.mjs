import Anthropic from '@anthropic-ai/sdk';
import { apiDetail, clientOptions, keyInUse, keyProblem, keyProblemText } from '../jobs/scoring/anthropic-key.mjs';
import { modelFor, modelInfo } from '../jobs/scoring/models.mjs';
import { AssistantError, carryOn, compactPrompt, estimateTokens, summaryOf } from './prompt.mjs';

const MAX_TOKENS = 16000;
const NO_USAGE = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const TOO_LONG = /prompt is too long|too many tokens|context (window|length)|exceeds? the (maximum|model)/i;

// How much a model reads at once. Every Claude model in Dayjob's list takes a million tokens but Claude Haiku 4.5;
// a typed-in model Dayjob does not know is taken for the smaller size.
export const contextWindow = model => (modelInfo('anthropic-api', model) && !/haiku-4-5/.test(model) ? 1_000_000 : 200_000);
// The size (in tokens) at which a conversation is compacted. Claude Code's numbers for a 200,000-token window:
// the window less the room kept for a reply and a margin, which comes to 167,000. A long conversation costs its
// whole length again with every request, so the larger windows are not filled up either. A model that really
// stops at 200,000 is compacted earlier, with room for one more round of tool results and the summary request.
export const compactLine = model => Math.min(167_000, contextWindow(model) - 93_000);

// The assistant on the Claude API, with the user's own key. Dayjob holds the conversation (the API keeps nothing)
// and runs the tool loop itself: each round streams a reply, runs the tools it asked for, and sends the results back.
// An application worked through in the Dayjob browser takes a few dozen rounds, so the limit on them is generous.
//
// A conversation that reaches compactAt(model) tokens is compacted the way Claude Code does it: the model is asked,
// in the conversation itself, for a summary of it, and the messages held here are replaced by that summary. It
// happens before a message is sent or between two rounds of a reply, and the reply then carries on from the summary.
// (The messages are never edited in place: a thinking block is only valid in the conversation that produced it,
// so what follows a summary is a new conversation that starts with it.)
export function createApiEngine({ getSettings, createClient = options => new Anthropic(options), maxRounds = 80, compactAt = compactLine }) {
  // conversation id -> the messages sent so far, exactly as the API returned them (thinking blocks included), and
  // context: how many tokens they came to at the last reply.
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
    // notes: what stands for the whole conversation (how applications are sent, the memory), given again after a
    // compaction. onCompacting / onCompact: a compaction has started / is done ({ trigger, summary, before }).
    // compacting: this message is itself Dayjob's request for a summary, so the engine does not compact on its own.
    async send({ id, text, system, model: wanted, tools, callTool, onText, onThinking, onRound, onDiscard, onCompacting = () => {}, onCompact = () => {}, notes = '', compacting = false, signal }) {
      const using = key();
      if (!using.apiKey) throw new AssistantError('no-key', 'Add an Anthropic API key in Settings.');
      const model = modelFor('anthropic-api', wanted);
      // Every current Claude model thinks adaptively; the oldest ones in the list take no thinking setting at all.
      const adaptive = modelInfo('anthropic-api', model)?.efforts.length !== 0;
      const client = createClient(clientOptions(using, { maxRetries: 2, timeout: 10 * 60 * 1000 }));
      const session = sessions.get(id) || { messages: [], context: 0 };
      sessions.set(id, session);
      const line = compacting ? 0 : compactAt(model);
      const usage = NO_USAGE();
      let served = model;
      let rounds = 0;
      let badJson = 0;
      // One request with the conversation as given. Everything but the messages is the same every time, so the
      // prompt, the tools and the conversation so far are read from the cache.
      const request = messages => client.messages.stream({
        model,
        max_tokens: MAX_TOKENS,
        cache_control: { type: 'ephemeral' },
        system,
        tools: tools.map(tool => ({ ...tool, eager_input_streaming: true })),
        ...(adaptive ? { thinking: { type: 'adaptive' } } : {}),
        messages,
      }, { signal });
      const count = message => {
        served = message.model || served;
        usage.inputTokens += message.usage?.input_tokens || 0;
        usage.outputTokens += message.usage?.output_tokens || 0;
        usage.cacheReadTokens += message.usage?.cache_read_input_tokens || 0;
        usage.cacheWriteTokens += message.usage?.cache_creation_input_tokens || 0;
        return (message.usage?.input_tokens || 0) + (message.usage?.cache_read_input_tokens || 0) + (message.usage?.cache_creation_input_tokens || 0) + (message.usage?.output_tokens || 0);
      };
      // Asks for a summary at the end of the conversation as it stands and puts the summary in its place. The
      // request is added to the last message when that is the user's (tool results), so nothing already sent
      // changes. A reply without a summary (the model reached for a tool instead) leaves everything as it was.
      // answering: the message being answered, when this happens in the middle of a reply.
      const squeeze = async (answering = '') => {
        onCompacting('auto');
        const ask = { type: 'text', text: compactPrompt() };
        const last = session.messages.at(-1);
        const asked = last?.role === 'user'
          ? [...session.messages.slice(0, -1), { role: 'user', content: [...(typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content), ask] }]
          : [...session.messages, { role: 'user', content: [ask] }];
        let message;
        try { message = await request(asked).finalMessage(); } catch (error) {
          if (error instanceof Anthropic.APIError || signal?.aborted) throw error;
          onThinking();
          return '';
        }
        count(message);
        const summary = message.stop_reason === 'refusal' ? '' : summaryOf(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
        if (!summary) { onThinking(); return ''; }
        const before = session.context;
        session.messages = [];
        session.context = estimateTokens(summary);
        onCompact({ trigger: 'auto', summary, before });
        return carryOn(summary, { notes, request: answering });
      };
      // The round a reply was last compacted in: it is not tried again for a few rounds, whatever came of it.
      let squeezedAt = -Infinity;
      let base = session.messages.length;
      try {
        // A conversation that has reached the line is compacted before the new message joins it.
        const head = line && base && session.context >= line ? await squeeze() : '';
        if (head) base = 0;
        session.messages.push({ role: 'user', content: head ? `${head}\n\n${text}` : text });
        for (;;) {
          onRound();
          onThinking();
          const stream = request(session.messages);
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
          session.context = count(message);
          if (message.stop_reason === 'refusal') throw new AssistantError('refusal', 'Claude declined this request.');
          session.messages.push({ role: 'assistant', content: message.content });
          if (message.stop_reason === 'pause_turn') continue;
          const calls = message.content.filter(block => block.type === 'tool_use');
          // A plain answer that ran out of room simply ends where it stopped.
          if (!calls.length) return { usage, model: served, rounds: rounds + 1, context: { tokens: session.context, limit: compactAt(model) || null } };
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
          session.context += results.reduce((sum, result) => sum + estimateTokens(result.content), 0);
          if (cut) throw new AssistantError('cut-off', 'The reply was cut off.');
          if (signal?.aborted) throw signal.reason || new Error('Stopped.');
          rounds += 1;
          if (rounds >= maxRounds) throw new AssistantError('too-many-steps', 'That took too many steps; ask again in smaller pieces.');
          // A reply that works through many tools can outgrow the line by itself: it is compacted between two
          // rounds and goes on from the summary, with the message it was answering.
          if (line && session.context >= line && rounds - squeezedAt >= 3) {
            squeezedAt = rounds;
            const head = await squeeze(text);
            if (head) { session.messages.push({ role: 'user', content: head }); base = 0; }
          }
        }
      } catch (error) {
        // A message that got no answer at all is taken back, so the next one does not carry it along.
        if (session.messages.length === base + 1) session.messages.length = base;
        if (!session.messages.length) sessions.delete(id);
        if (signal?.aborted || error instanceof AssistantError) throw error;
        // A conversation that no longer fits is let go of here: the next message starts from the turns Dayjob keeps,
        // which are short, with the older ones summarised.
        if (error instanceof Anthropic.APIError && error.status === 400 && TOO_LONG.test(apiDetail(error))) {
          sessions.delete(id);
          throw new AssistantError('context-full', 'The conversation grew too long for the model. Send the message again: the assistant will go on from a summary.');
        }
        if (keyProblem(error)) throw new AssistantError(keyProblem(error), keyProblemText(keyProblem(error)));
        if (error instanceof Anthropic.RateLimitError) throw new AssistantError('rate-limit', 'The Claude API is rate limiting requests. Try again in a moment.');
        if (error instanceof Anthropic.APIConnectionError) throw new AssistantError('offline', 'Could not reach the Claude API. Check the network connection.');
        if (error instanceof Anthropic.APIError) throw new AssistantError('api', `Claude API error ${error.status}: ${apiDetail(error)}`);
        throw error;
      }
    },
  };
}
