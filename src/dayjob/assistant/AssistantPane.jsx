import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowUp, Check, ChevronRight, History, Pin, PinOff, Search, Square, SquarePen, Trash2, TriangleAlert, Undo2, X } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { relativeDay } from '../format.js';
import { Markdown } from '../Markdown.jsx';
import { serverText } from '../server-text.js';
import { Gramophone } from './Gramophone.jsx';
import { assistant, useAssistant } from './store.js';

const ENGINE_NAMES = { 'claude-cli': 'Claude Code', 'anthropic-api': 'Claude API' };
const STARTERS = [
  ['今天有哪些高分的新岗位？', 'Which new jobs score highest today?'],
  ['哪些投递该跟进了？', 'Which applications need a follow-up?'],
  ['这周我投了多少份，离目标还差多少？', 'How many did I apply to this week, and how far from my goal?'],
];
// What went wrong, in the user's language; anything not listed shows the server's own words.
const ERRORS = {
  'no-key': ['还没有可用的 Anthropic API key。到“设置”的 API key 里添加一个，或者把助手换成用 Claude Code。', 'There is no Anthropic API key yet. Add one under API key in Settings, or switch the assistant to Claude Code.'],
  'bad-key': ['这个 Anthropic API key 被拒绝了，请到“设置”的 API key 里检查。', 'The Anthropic API key was rejected. Check it under API key in Settings.'],
  'rate-limit': ['Claude API 现在限流，稍等一会儿再试。', 'The Claude API is rate limiting requests. Try again in a moment.'],
  offline: ['连不上 Claude API，请检查网络。', 'Could not reach the Claude API. Check the network connection.'],
  refusal: ['Claude 没有接这个请求。', 'Claude declined this request.'],
  'cut-off': ['回答太长被截断了，换个小一点的问题再问一次。', 'The reply was cut off. Ask again in a smaller piece.'],
  'too-many-steps': ['这件事步骤太多了，拆成几句小的再说。', 'That took too many steps. Ask again in smaller pieces.'],
  'no-cli': ['没有找到 Claude Code。请先安装并登录，或者在“简历与 AI”里填它的路径。', 'Claude Code was not found. Install it and sign in, or set its path under Resume & AI.'],
  'old-cli': ['这个 Claude Code 版本太旧，助手用不了。更新 Claude Code 后再试。', 'This Claude Code is too old for the assistant. Update Claude Code and try again.'],
  'signed-out': ['Claude Code 还没有登录。在终端运行 claude，输入 /login 登录后再试。', 'Claude Code is not signed in. Run claude in a terminal and type /login, then try again.'],
  quiet: ['Claude Code 很久没有回应，这次先停下了。再发一次试试。', 'Claude Code stopped responding, so this reply was ended. Send it again.'],
  'mcp-failed': ['Claude Code 没能连上 Dayjob 的工具。再发一次试试。', 'Claude Code could not connect to Dayjob\'s tools. Send it again.'],
  internal: ['助手出了点问题，再试一次。', 'The assistant ran into a problem. Try again.'],
};

// One thing the assistant did. A change carries its undo; a lookup is just a quiet line.
function ToolChip({ tool, busy }) {
  const { t } = useI18n();
  const [working, setWorking] = useState(false);
  if (tool.running) return <span className="asst-chip running"><i className="asst-dots" aria-hidden="true"><b /><b /><b /></i>{t('正在操作…', 'Working…')}</span>;
  if (!tool.ok) return <span className="asst-chip failed" ><TriangleAlert size={13} />{t('没做成：', 'Did not work: ')}{serverText(tool.error)}</span>;
  const changed = tool.tier === 'undoable';
  async function undo() {
    setWorking(true);
    await assistant.undo(tool.id);
    setWorking(false);
  }
  return (
    <span className={`asst-chip${changed ? ' changed' : ''}${tool.undone ? ' undone' : ''}`}>
      {changed ? <Check size={13} /> : <Search size={13} />}
      <span>{tool.label ? t(...tool.label) : tool.name}</span>
      {tool.undone ? <em>{t('已撤销', 'Undone')}</em> : null}
      {tool.undoable ? <button type="button" disabled={working || busy} onClick={undo}><Undo2 size={12} />{t('撤销', 'Undo')}</button> : null}
    </span>
  );
}

// While a reply is still arriving, a "**" that has not met its partner yet would show as two stars; it waits offstage.
const settled = text => ((text.match(/\*\*/g) || []).length % 2 ? text.slice(0, text.lastIndexOf('**')) + text.slice(text.lastIndexOf('**') + 2) : text);

// A reply: its text with each tool call shown where it happened.
function Reply({ turn, busy }) {
  const { t } = useI18n();
  const tools = [...(turn.tools || [])].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
  const parts = [];
  let from = 0;
  tools.forEach((tool, index) => {
    const at = Math.min(Math.max(tool.offset ?? turn.text.length, from), turn.text.length);
    if (at > from) parts.push({ text: turn.text.slice(from, at) });
    from = at;
    const last = parts[parts.length - 1];
    if (last?.tools) last.tools.push(tool); else parts.push({ tools: [tool], key: `tools-${index}` });
  });
  if (turn.text.length > from) parts.push({ text: turn.text.slice(from) });
  const waiting = turn.writing && !turn.text && !tools.length;
  const known = turn.errorCode && ERRORS[turn.errorCode];
  return (
    <div className="asst-reply">
      {parts.map((part, index) => (part.tools
        ? <div key={part.key} className="asst-chips">{part.tools.map(tool => <ToolChip key={tool.id} tool={tool} busy={busy} />)}</div>
        : <Markdown key={`text-${index}`} text={turn.writing ? settled(part.text) : part.text} />))}
      {waiting ? <i className="asst-dots" role="status" aria-label={t('正在想', 'Thinking')}><b /><b /><b /></i> : null}
      {turn.stopped ? <p className="asst-note">{t('已停止', 'Stopped')}</p> : null}
      {turn.error ? <p className="asst-note error"><TriangleAlert size={14} />{known ? t(...known) : serverText(turn.error)}</p> : null}
    </div>
  );
}

// Delete asks once more: the first click turns the button into the question, and looking away takes it back.
function DeleteButton({ id }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return <button type="button" className="button small danger-fill" autoFocus onBlur={() => setConfirming(false)}
      onClick={() => { setConfirming(false); void assistant.remove(id); }}>{t('确认删除', 'Delete')}</button>;
  }
  return <button type="button" className="icon-button" title={t('删除这段对话', 'Delete this conversation')} aria-label={t('删除这段对话', 'Delete this conversation')} onClick={() => setConfirming(true)}><Trash2 size={15} /></button>;
}

function ArchiveButton({ id, archived }) {
  const { t } = useI18n();
  const label = archived ? t('取消归档', 'Take out of the archive') : t('归档这段对话', 'Archive this conversation');
  return <button type="button" className="icon-button" title={label} aria-label={label} onClick={() => assistant.archive(id, !archived)}>{archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}</button>;
}

// The kept conversations, and under a fold the ones put away in the archive. Each can be opened, archived or deleted.
function HistoryList({ kept, currentId, onPick }) {
  const { t } = useI18n();
  const [showArchived, setShowArchived] = useState(false);
  const active = kept.filter(item => !item.archivedAt);
  const archived = kept.filter(item => item.archivedAt);
  const rows = items => (
    <ul className="asst-history-list">
      {items.map(item => (
        <li key={item.id} className={item.id === currentId ? 'current' : ''}>
          <button type="button" className="asst-history-open" onClick={() => onPick(item.id)}>
            <strong>{item.title || t('（没有标题）', '(untitled)')}</strong>
            <small>{relativeDay(item.updatedAt)} · {t(`${Math.ceil(item.turns / 2)} 轮`, `${Math.ceil(item.turns / 2)} ${Math.ceil(item.turns / 2) === 1 ? 'exchange' : 'exchanges'}`)}</small>
          </button>
          <ArchiveButton id={item.id} archived={Boolean(item.archivedAt)} />
          <DeleteButton id={item.id} />
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {active.length ? rows(active) : (
        <p className="asst-history-empty">{archived.length ? t('保留的对话都在归档里。', 'Every kept conversation is in the archive.')
          : t('还没有保留的对话。对话默认不保存；想留下来的，点“保留这段对话”或归档。', 'No kept conversations yet. Conversations are not saved unless you choose “Keep” or archive one.')}</p>
      )}
      {archived.length ? (
        <>
          <button type="button" className={`asst-history-fold${showArchived ? ' open' : ''}`} aria-expanded={showArchived} onClick={() => setShowArchived(value => !value)}>
            <ChevronRight size={14} />{t(`已归档 ${archived.length}`, `Archived ${archived.length}`)}
          </button>
          {showArchived ? rows(archived) : null}
        </>
      ) : null}
    </>
  );
}

// The assistant, docked at the right edge of the window: a gramophone you talk with.
export function AssistantPane({ onClose, openItem }) {
  const { t } = useI18n();
  const { info, conversation, busy, phase, failure } = useAssistant();
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const scroller = useRef(null);
  const field = useRef(null);
  const pinned = useRef(true);
  const turns = conversation?.turns || [];
  const engine = info?.settings.engine;
  const engineState = engine ? info.engines[engine] : null;
  const keptCount = (info?.kept || []).filter(item => !item.archivedAt).length;
  const archived = Boolean(conversation?.archivedAt);

  useEffect(() => { void assistant.refresh(); }, []);
  useEffect(() => { field.current?.focus(); }, [conversation?.id]);
  // Follows the reply down the page unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  });
  // The box grows with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }, [draft]);

  function send(text = draft) {
    if (busy || !text.trim()) return;
    pinned.current = true;
    setDraft('');
    setShowHistory(false);
    void assistant.send(text);
  }
  function onKeyDown(event) {
    // Enter sends; Shift+Enter is a new line. An Enter that only confirms a Chinese input candidate is left alone.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  }
  const status = phase === 'thinking' ? t('在想…', 'Thinking…') : phase === 'speaking' ? t('在回答…', 'Answering…') : phase === 'tool' ? t('在操作…', 'Working…')
    : engine ? ENGINE_NAMES[engine] : '';

  return (
    <aside className="assistant-pane" aria-label={t('助手', 'Assistant')}>
      <header className="asst-head">
        <Gramophone phase={phase} strip label={t('助手留声机', 'Assistant gramophone')} />
        <div className="asst-title">
          <strong>{t('助手', 'Assistant')}</strong>
          {phase === 'idle' && engine
            ? <button type="button" className="asst-engine" title={t('在设置里换引擎', 'Change the engine in Settings')} onClick={() => openItem('settings', 'assistant')}>{status}</button>
            : <small aria-live="polite">{status}</small>}
        </div>
        <button type="button" className="icon-button" title={t('新对话', 'New conversation')} aria-label={t('新对话', 'New conversation')} disabled={!turns.length}
          onClick={() => { setShowHistory(false); void assistant.reset(); }}><SquarePen size={17} /></button>
        <button type="button" className={`icon-button${showHistory ? ' on' : ''}`} title={t('保留的对话', 'Kept conversations')} aria-label={t('保留的对话', 'Kept conversations')} aria-expanded={showHistory}
          onClick={() => { setShowHistory(value => !value); if (!showHistory) void assistant.refresh(); }}><History size={17} />{keptCount ? <em>{keptCount}</em> : null}</button>
        <button type="button" className="icon-button" title={t('收起助手', 'Close the assistant')} aria-label={t('收起助手', 'Close the assistant')} onClick={onClose}><X size={18} /></button>
      </header>
      {showHistory ? (
        <div className="asst-history">
          <HistoryList kept={info?.kept || []} currentId={conversation?.id} onPick={id => { setShowHistory(false); pinned.current = true; void assistant.openKept(id); }} />
        </div>
      ) : null}
      {turns.length ? (
        <div className={`asst-keep${archived ? ' archived' : conversation.kept ? ' kept' : ''}`}>
          {archived ? <Archive size={14} /> : conversation.kept ? <Pin size={14} /> : <PinOff size={14} />}
          <span>{archived ? t('这段对话已归档', 'This conversation is archived') : conversation.kept ? t('这段对话保留在这台电脑上', 'Kept on this computer')
            : t('这段对话不保存，新开对话或退出后就没了', 'Not saved: gone once you start a new one or quit')}</span>
          {archived ? <button type="button" className="button small" onClick={() => assistant.archive(conversation.id, false)}>{t('取消归档', 'Unarchive')}</button>
            : <button type="button" className="button small" disabled={!conversation.id} onClick={() => assistant.keep(!conversation.kept)}>{conversation.kept ? t('不再保留', 'Stop keeping') : t('保留这段对话', 'Keep')}</button>}
          {conversation.id ? (
            <>
              {archived ? null : <ArchiveButton id={conversation.id} archived={false} />}
              <DeleteButton id={conversation.id} />
            </>
          ) : null}
        </div>
      ) : null}
      <div className="asst-scroll" ref={scroller} onScroll={event => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>
        {turns.length ? turns.map((turn, index) => (turn.role === 'user'
          ? <div key={index} className="asst-said"><p>{turn.text}</p></div>
          : <Reply key={index} turn={turn} busy={busy} />)) : (
          <div className="asst-empty">
            <Gramophone scale={3} label={t('助手留声机', 'Assistant gramophone')} />
            <h2>{t('有事直接说', 'Just say it')}</h2>
            <p>{t('查岗位、记一笔投递、改搜索条件、开始抓取，都可以用一句话交给我。我改动的每一处都能一键撤销。', 'Look up jobs, record an application, change a search or start one: say it in a sentence. Every change I make can be undone in one click.')}</p>
            <div className="asst-starters">
              {STARTERS.map(([zh, en]) => <button key={en} type="button" className="button small" disabled={busy} onClick={() => send(t(zh, en))}>{t(zh, en)}</button>)}
            </div>
          </div>
        )}
      </div>
      {failure ? <p className="notice error asst-failure" role="alert">{failure}<button type="button" className="icon-button" aria-label={t('关闭', 'Dismiss')} onClick={() => assistant.clearFailure()}><X size={14} /></button></p> : null}
      {engineState && !engineState.available ? (
        <p className="asst-engine-off"><TriangleAlert size={14} />
          {engine === 'claude-cli' ? t('没有找到 Claude Code。', 'Claude Code was not found.') : t('还没有 Anthropic API key。', 'There is no Anthropic API key yet.')}
          <button type="button" className="asst-link" onClick={() => openItem('settings', engine === 'claude-cli' ? 'assistant' : 'api-keys')}>{t('去设置', 'Open Settings')}</button>
        </p>
      ) : null}
      <form className="asst-compose" onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea ref={field} rows={1} value={draft} maxLength={8000} placeholder={t('跟助手说点什么…', 'Say something to the assistant…')} aria-label={t('给助手的消息', 'Message to the assistant')}
          onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        {busy
          ? <button type="button" className="asst-send stop" title={t('停止', 'Stop')} aria-label={t('停止', 'Stop')} onClick={() => assistant.stop()}><Square size={14} /></button>
          : <button type="submit" className="asst-send" title={t('发送', 'Send')} aria-label={t('发送', 'Send')} disabled={!draft.trim()}><ArrowUp size={17} /></button>}
      </form>
    </aside>
  );
}
