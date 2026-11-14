import { useEffect, useState } from 'react';
import { Check, CheckCircle2, NotebookPen, Pencil, Plus, Speaker as SpeakerIcon, Trash2, X } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { Select } from '../groove/Picker.jsx';
import { ApplySwitch } from './AssistantPane.jsx';
import { GuideHelp } from '../guide/GuideHelp.jsx';
import { assistant, useAssistant } from './store.js';

const ENGINES = [
  ['claude-cli', 'Claude Code', ['用这台电脑上已登录的 Claude Code，不需要 API key，用的是你订阅里的额度。', 'Uses the Claude Code signed in on this computer. No API key needed; it draws on your subscription.']],
  ['anthropic-api', 'Claude API', ['用你自己的 Anthropic API key，按量计费。key 在上面的“API key”里填。', 'Uses your own Anthropic API key, billed by use. Enter the key under API key above.']],
];
const MODEL_TAGS = { recommended: ['推荐', 'recommended'], top: ['最强', 'most capable'], fast: ['快、省', 'fast, cheap'], older: ['旧版', 'older'] };

const MEMORY_MAX = 60;
const MEMORY_TEXT = 400;

// 助手的记忆: the standing answers and preferences the assistant works from ("Protected veteran: I am not one"). The
// user adds, rewords and removes them here; the assistant adds its own when told "remember…" in the chat.
function Memory({ notes, focused }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (focused) document.getElementById('assistant-memory')?.scrollIntoView({ block: 'start' }); }, [focused]);
  const run = async (work, after) => {
    setBusy(true);
    setError('');
    try { await work(); after?.(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  const add = event => { event.preventDefault(); void run(() => assistant.memory.add(text), () => setText('')); };
  const save = event => { event.preventDefault(); void run(() => assistant.memory.update(editing.id, editing.text), () => setEditing(null)); };
  return (
    <>
      <h2 id="assistant-memory" data-guide="memory"><NotebookPen size={18} />{t('助手的记忆', 'What the assistant keeps in mind')}<GuideHelp id="memory" /></h2>
      <p className="hint" data-guide="memory">{t('写下每次都一样的答案和你的偏好，一条一行。助手填申请表、回答问题时会照着做，不再每次问你；在对话里说“记住……”，它也会自己记到这里。这些内容保存在这台电脑上，对话时会发给模型，所以不要写密码。',
        'Write down the answers that are the same every time and how you like things done, one to a line. The assistant follows them when it fills in applications and answers questions, without asking each time; say “remember…” in the chat and it adds a note here itself. The notes stay on this computer and go to the model with a conversation, so do not write passwords.')}</p>
      <form className="memory-add" data-guide="memory" onSubmit={add}>
        <input value={text} maxLength={MEMORY_TEXT} onChange={event => setText(event.target.value)} disabled={notes.length >= MEMORY_MAX}
          placeholder={t('例如：是否受保护退伍军人，选“不是”', 'For example: Protected veteran status: choose “I am not a protected veteran”')} aria-label={t('新的一条记忆', 'A new note')} />
        <button type="submit" className="button primary" disabled={busy || text.trim().length < 2 || notes.length >= MEMORY_MAX}><Plus size={15} />{t('记住', 'Remember')}</button>
      </form>
      {error ? <p className="notice error" onClick={() => setError('')}>{error}</p> : null}
      {notes.length ? (
        <ul className="memory-list" data-guide="memory">
          {notes.map(note => (editing?.id === note.id ? (
            <li key={note.id}>
              <form onSubmit={save}>
                <input value={editing.text} maxLength={MEMORY_TEXT} autoFocus onChange={event => setEditing({ id: note.id, text: event.target.value })}
                  onKeyDown={event => { if (event.key === 'Escape') setEditing(null); }} aria-label={t('修改这条记忆', 'Reword this note')} />
                <button type="submit" className="icon-button" title={t('保存', 'Save')} aria-label={t('保存', 'Save')} disabled={busy || editing.text.trim().length < 2}><Check size={15} /></button>
                <button type="button" className="icon-button" title={t('取消', 'Cancel')} aria-label={t('取消', 'Cancel')} onClick={() => setEditing(null)}><X size={15} /></button>
              </form>
            </li>
          ) : (
            <li key={note.id}>
              <p>{note.text}{note.by === 'assistant' ? <small>{t('助手记的', 'noted by the assistant')}</small> : null}</p>
              <button className="icon-button" title={t('修改', 'Reword')} aria-label={t('修改', 'Reword')} onClick={() => { setError(''); setEditing({ id: note.id, text: note.text }); }}><Pencil size={14} /></button>
              <button className="icon-button" title={t('删掉', 'Remove')} aria-label={t('删掉', 'Remove')} disabled={busy} onClick={() => run(() => assistant.memory.remove(note.id))}><Trash2 size={14} /></button>
            </li>
          )))}
        </ul>
      ) : <p className="hint memory-empty" data-guide="memory">{t('还没有记下任何东西。常用的几条：是否需要签证担保、是否受保护退伍军人、是否残障、性别和族裔怎么选、期望薪资怎么填、最早入职时间。',
        'Nothing is kept in mind yet. The usual ones: whether you need visa sponsorship, protected veteran status, disability status, how to answer gender and ethnicity, what to put for expected salary, your earliest start date.')}</p>}
      {notes.length >= MEMORY_MAX ? <small className="hint">{t(`最多 ${MEMORY_MAX} 条，删掉一条才能再加。`, `Up to ${MEMORY_MAX} notes; remove one to add another.`)}</small> : null}
    </>
  );
}

// Settings → Assistant: which engine answers in the pane, and with which model.
export function AssistantSettings({ hasKey, focus }) {
  const { t } = useI18n();
  const { info } = useAssistant();
  // Asked again when a key is added or removed above, so the line below is never out of date.
  useEffect(() => { void assistant.refresh(); }, [hasKey]);
  if (!info) return null;
  const { engine, models } = info.settings;
  const state = info.engines[engine];
  const defaultName = info.models.find(item => item.id === info.defaultModels[engine])?.name;
  return (
    <section className="card-section" id="assistant">
      <h2 data-guide="assistant"><SpeakerIcon size={18} />{t('助手', 'Assistant')}<GuideHelp id="assistant" /></h2>
      <p className="hint" data-guide="assistant">{info.browser
        ? t('侧边栏里那台留声机，可以开在窗口右边，也可以占满整页。它能查岗位和投递、收藏、记投递、改搜索、开始抓取，改动都可以一键撤销；还能在 Dayjob 浏览器里替你投递：打开投递页、让密码保管在本机登录、填表、附上合适的简历、写求职信。密码和简历原件都不会交给模型，它只知道登录成没成、附的是哪份文件。对话默认不保存。',
          'The gramophone in the sidebar, opened at the right of the window or as a full page. It can look up jobs and applications, save jobs, record applications, change searches and start one, and every change can be undone in one click. It can also apply for you in the Dayjob browser: open the application page, have the vault sign in on this computer, fill in the form, attach the resume that fits and write the cover letter. Passwords and resume files never go to the model; it learns only whether the sign-in worked and which file was attached. Conversations are not saved unless you keep them.')
        : t('侧边栏里那台留声机，可以开在窗口右边，也可以占满整页。它能查岗位和投递、收藏、记投递、改搜索、开始抓取，改动都可以一键撤销；它碰不到密码保管。对话默认不保存。',
          'The gramophone in the sidebar, opened at the right of the window or as a full page. It can look up jobs and applications, save jobs, record applications, change searches and start one, and every change can be undone in one click. It cannot reach the password vault. Conversations are not saved unless you keep them.')}</p>
      <div className="option-row" data-guide="assistant">
        <span>{t('引擎', 'Engine')}</span>
        <div className="segmented" role="group" aria-label={t('助手引擎', 'Assistant engine')}>
          {ENGINES.map(([id, name]) => <button key={id} type="button" className={engine === id ? 'active' : ''} aria-pressed={engine === id} data-fx="lang" onClick={() => assistant.saveSettings({ engine: id })}>{name}</button>)}
        </div>
        <small>{t(...ENGINES.find(([id]) => id === engine)[2])}</small>
      </div>
      <p className={`status-line ${state.available ? 'ok' : 'off'}`} data-guide="assistant">{state.available ? <CheckCircle2 size={15} /> : null}
        {state.available ? (engine === 'claude-cli' ? t(`已找到 ${state.detail}`, `Found ${state.detail}`) : t('已有 Anthropic API key，可以用', 'An Anthropic API key is set')) : engine === 'claude-cli' ? t('没有找到 Claude Code。请先安装并登录，或在“简历与 AI”里填它的路径。', 'Claude Code was not found. Install it and sign in, or set its path under Resume & AI.')
          : t('还没有 Anthropic API key。', 'There is no Anthropic API key yet.')}</p>
      <div className="option-row" data-guide="assistant">
        <span>{t('模型', 'Model')}</span>
        <Select value={models[engine]} onChange={event => assistant.saveSettings({ models: { [engine]: event.target.value } })}>
          <option value="">{engine === 'claude-cli' ? t('跟随 Claude Code 自己的设置', 'Claude Code\'s own setting') : t(`默认（${defaultName}）`, `Default (${defaultName})`)}</option>
          {info.models.map(item => <option key={item.id} value={item.id}>{item.name}{item.tag ? ` · ${t(...MODEL_TAGS[item.tag])}` : ''}</option>)}
        </Select>
        <small>{t('换引擎或模型后，正在进行的对话会接着聊：Dayjob 把之前的内容交给新的引擎。', 'After a switch, the open conversation carries on: Dayjob hands what was said to the new engine.')}</small>
      </div>
      {info.browser ? (
        <div className="option-row" data-guide="assistant">
          <span>{t('替你投递', 'Applying for you')}</span>
          <ApplySwitch mode={info.settings.apply} bare />
          <small>{info.settings.apply === 'takeover'
            ? t('全权接管：助手自己点“提交”。验证码、付款和只有你知道答案的问题，它仍然会停下来问你。这个开关也在对话框旁边。', 'Full takeover: the assistant clicks “Submit” itself. It still stops and asks at a captcha, a payment, or a question only you can answer. The same switch sits beside the chat box.')
            : t('手动确认：提交之前，对话里会出现一张卡片，按住“投递”才会发出去。这个开关也在对话框旁边。', 'Ask me first: before anything is sent, a card appears in the chat and it goes out only when you hold “Send”. The same switch sits beside the chat box.')}</small>
        </div>
      ) : null}
      <Memory notes={info.memory || []} focused={focus === 'assistant-memory'} />
    </section>
  );
}
