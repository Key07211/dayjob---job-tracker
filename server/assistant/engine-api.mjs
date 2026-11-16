import Anthropic from '@anthropic-ai/sdk';
import { apiDetail, clientOptions, keyInUse, keyProblem, keyProblemText } from '../jobs/scoring/anthropic-key.mjs';
import { modelFor, modelInfo } from '../jobs/scoring/models.mjs';
import { AssistantError, carryOn, compactPrompt, estimateTokens, summaryOf } from './prompt.mjs';

const MAX_TOKENS = 16000;
const NO_USAGE = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const TOO_LONG = /prompt is too long|too many tokens|context (window|length)|exceeds? the (maximum|model)/i;
// How long the API keeps a conversation in its cache after the last request. A request that comes later pays for
// the whole conversation again at the full price, so that is the moment to make the conversation smaller.
const CACHE_MS = 5 * 60 * 1000;
// How many readings of a page stay in the conversation as they were; older ones are cut to a line.
const READS_KEPT = 2;
// The tool the model asks for a group of tools with.
export const LOADER = 'load_tools';
// What the API says when it will not take tools that load later, or a thinking block that no longer fits.
const NO_DEFERRAL = /defer_loading|tool_reference|deferred/i;
const BAD_THINKING = /thinking|signature/i;

const eager = tool => ({ ...tool, eager_input_streaming: true });
const sizeOf = content => (typeof content === 'string' ? estimateTokens(content) : 20 * (content?.length || 0));
const isThinking = block => block.type === 'thinking' || block.type === 'redacted_thinking';
function loaderTool(hidden) {
  return {
    name: LOADER,
    description: 'Some of your tools are not loaded yet, so that a conversation which does not need them stays short. They exist: a tool your instructions name and you do not see '
      + 'is in one of these groups. Load a group before you need one of its tools, and before telling the user you cannot do something it covers; then use the tools as usual. '
      + `One call loads a group for the rest of the conversation. Groups: ${[...hidden].map(([group, item]) => `${group}: ${item.about}`).join('. ')}.`,
    input_schema: { type: 'object', properties: { group: { type: 'string', enum: [...hidden.keys()] } }, required: ['group'], additionalProperties: false },
  };
}
// The tools as a conversation is given them from its first request to its last. groups: { name: { about, tools } },
// the tools that can wait until the model asks for them (it sees their group in the loader's description, not their
// definitions: the API keeps a tool marked defer_loading out of the prompt until a result names it). preload: the
// groups this conversation plainly needs from the start.
function arrange(tools, groups, preload) {
  const hidden = new Map();
  for (const [group, item] of Object.entries(groups || {})) {
    const names = item.tools.filter(name => tools.some(tool => tool.name === name));
    if (names.length && !preload.includes(group)) hidden.set(group, { about: item.about, names });
  }
  if (!hidden.size) return { list: tools.map(eager), hidden: null };
  const later = new Set([...hidden.values()].flatMap(item => item.names));
  return { list: [...tools.map(tool => (later.has(tool.name) ? { ...eager(tool), defer_loading: true } : eager(tool))), eager(loaderTool(hidden))], hidden };
}

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
// (While a reply is being worked out the messages are never edited: a thinking block is only valid in the
// conversation that produced it, and every request reads what came before from the cache, at a fraction of the price,
// only as long as it is the same to the letter. So what follows a summary is a new conversation that starts with it.)
//
// Two things keep a conversation small without a summary:
// - Old readings of a page. A reading (a tool result that comes with `stale`, the line to put in its place) is the
//   bulkiest thing in a conversation and is out of date as soon as the page is read again. Only the last two stay.
//   The older ones are cut when a message arrives after the cache has run out (CACHE_MS): then everything is paid
//   for anew anyway, so cutting costs nothing and saves writing them again. In the middle of a reply nothing is
//   cut: rewriting the conversation there costs many times what carrying a few old readings does. The thinking
//   blocks after the first cut go with it, as they would no longer be valid.
// - Tools that wait. The groups in `groups` are declared with defer_loading and stay out of the prompt until the
//   model loads one with the loader tool (see arrange); the list of tools itself never changes during a
//   conversation. Should the API refuse this, the conversation goes on with every tool loaded.
export function createApiEngine({ getSettings, createClient = options => new Anthropic(options), maxRounds = 80, compactAt = compactLine, clock = Date.now }) {
  // conversation id -> the messages sent so far, exactly as the API returned them (thinking blocks included);
  // context: how many tokens they came to at the last reply; tools: the tools as first sent; hidden: the groups
  // that wait; loaded: the groups the model has asked for; reads: the page readings in the messages, oldest first;
  // sentAt: when the last request left.
  const sessions = new Map();
  const key = () => keyInUse(getSettings().ai);
  // Set once the API has refused tools that load later: from then on every conversation gets all of them at once.
  let plainTools = false;

  // Without its thinking blocks from `from` on, a conversation is valid again after a change to what came before them.
  function unthink(session, from = 0) {
    session.messages.forEach((message, index) => {
      if (index < from || message.role !== 'assistant' || !Array.isArray(message.content) || !message.content.some(isThinking)) return;
      const rest = message.content.filter(block => !isThinking(block));
      message.content = rest.length ? rest : [{ type: 'text', text: '(no text)' }];
    });
  }
  // Cuts every reading of a page but the last READS_KEPT to the line that came with it. Returns the tokens saved.
  function prune(session) {
    const there = new Set(session.messages.flatMap(message => (message.role === 'user' && Array.isArray(message.content) ? message.content : []))
      .filter(block => block.type === 'tool_result').map(block => block.tool_use_id));
    session.reads = session.reads.filter(read => there.has(read.id));
    const old = new Map(session.reads.slice(0, -READS_KEPT).map(read => [read.id, read.stale]));
    session.reads = session.reads.slice(-READS_KEPT);
    if (!old.size) return 0;
    let first = -1;
    let saved = 0;
    session.messages.forEach((message, index) => {
      if (message.role !== 'user' || !Array.isArray(message.content)) return;
      message.content = message.content.map(block => {
        if (block.type !== 'tool_result' || !old.has(block.tool_use_id)) return block;
        if (first < 0) first = index;
        saved += Math.max(0, sizeOf(block.content) - sizeOf(old.get(block.tool_use_id)));
        return { ...block, content: old.get(block.tool_use_id) };
      });
    });
    if (first >= 0) unthink(session, first);
    session.context = Math.max(0, session.context - saved);
    return saved;
  }
  // Every tool at once, after the API refused tools that load later. The loader stays in the list when the model
  // has used it, and what it answered becomes plain words.
  function loadAll(session, tools) {
    plainTools = true;
    const used = session.messages.some(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use' && block.name === LOADER));
    session.tools = [...tools.map(eager), ...(used ? [eager(loaderTool(session.hidden))] : [])];
    session.hidden = null;
    for (const message of session.messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue;
      message.content = message.content.map(block => (block.type === 'tool_result' && Array.isArray(block.content) ? { ...block, content: 'These tools are loaded.' } : block));
    }
    unthink(session);
  }

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
    // groups, preload: the tools that can wait and the groups wanted at once (see arrange); they count when the
    // conversation starts here and not after. A tool result may come with `stale`, the line that stands for it once
    // it is an old reading of a page.
    async send({ id, text, system, model: wanted, tools, groups = null, preload = [], callTool, onText, onThinking, onRound, onDiscard, onCompacting = () => {}, onCompact = () => {}, notes = '', compacting = false, signal }) {
      const using = key();
      if (!using.apiKey) throw new AssistantError('no-key', 'Add an Anthropic API key in Settings.');
      const model = modelFor('anthropic-api', wanted);
      // Every current Claude model thinks adaptively; the oldest ones in the list take no thinking setting at all.
      const adaptive = modelInfo('anthropic-api', model)?.efforts.length !== 0;
      const client = createClient(clientOptions(using, { maxRetries: 2, timeout: 10 * 60 * 1000 }));
      let session = sessions.get(id);
      if (!session) {
        // Tools wait only on a model Dayjob knows takes that (every Claude model in its list does).
        const { list, hidden } = arrange(tools, !plainTools && modelInfo('anthropic-api', model) ? groups : null, preload);
        session = { messages: [], context: 0, tools: list, hidden, loaded: new Set(), reads: [], sentAt: 0 };
      }
      sessions.set(id, session);
      // The cache has run out: what is sent now is paid for in full, so the old page readings are cut first.
      if (!compacting && session.sentAt && clock() - session.sentAt >= CACHE_MS) prune(session);
      const line = compacting ? 0 : compactAt(model);
      const usage = NO_USAGE();
      let served = model;
      let rounds = 0;
      let badJson = 0;
      // One request with the conversation as given. Everything but the messages is the same every time, so the
      // prompt, the tools and the conversation so far are read from the cache.
      const request = messages => {
        session.sentAt = clock();
        return client.messages.stream({
          model,
          max_tokens: MAX_TOKENS,
          cache_control: { type: 'ephemeral' },
          system,
          tools: session.tools,
          ...(adaptive ? { thinking: { type: 'adaptive' } } : {}),
          messages,
        }, { signal });
      };
      // A request the API will not take as it is, for a reason Dayjob can mend: tools that load later (then every
      // tool is loaded at once), or a thinking block that no longer fits what came before it (then the thinking
      // blocks go). Each is mended once; true means the request is worth sending again.
      let mended = false;
      const mend = error => {
        if (mended || !(error instanceof Anthropic.APIError) || error.status !== 400) return false;
        const said = apiDetail(error);
        if (TOO_LONG.test(said)) return false;
        if (session.hidden && NO_DEFERRAL.test(said)) loadAll(session, tools);
        else if (BAD_THINKING.test(said) && session.messages.some(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(isThinking))) unthink(session);
        else return false;
        mended = true;
        return true;
      };
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
        session.reads = [];
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
            if (!signal?.aborted && mend(error)) { onDiscard(); continue; }
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
            // The loader is answered here: the API puts the definitions of the tools named in the result into the prompt.
            if (call.name === LOADER) {
              const group = session.hidden?.get(call.input?.group);
              const fresh = group && !session.loaded.has(call.input.group);
              if (fresh) session.loaded.add(call.input.group);
              results.push(fresh ? { type: 'tool_result', tool_use_id: call.id, content: group.names.map(name => ({ type: 'tool_reference', tool_name: name })) }
                : { type: 'tool_result', tool_use_id: call.id, content: group || !session.hidden ? 'These tools are loaded.' : `There is no such group. Groups: ${[...session.hidden.keys()].join(', ')}.`,
                  ...(group || !session.hidden ? {} : { is_error: true }) });
              continue;
            }
            const outcome = await callTool(call.name, call.input);
            results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, ...(outcome.ok ? {} : { is_error: true }) });
            if (outcome.ok && outcome.stale) session.reads.push({ id: call.id, stale: outcome.stale });
          }
          session.messages.push({ role: 'user', content: results });
          session.context += results.reduce((sum, result) => sum + sizeOf(result.content), 0);
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
