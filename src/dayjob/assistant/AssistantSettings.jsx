import { useEffect } from 'react';
import { CheckCircle2, Speaker as SpeakerIcon } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { Select } from '../groove/Picker.jsx';
import { ApplySwitch } from './AssistantPane.jsx';
import { assistant, useAssistant } from './store.js';

const ENGINES = [
  ['claude-cli', 'Claude Code', ['用这台电脑上已登录的 Claude Code，不需要 API key，用的是你订阅里的额度。', 'Uses the Claude Code signed in on this computer. No API key needed; it draws on your subscription.']],
  ['anthropic-api', 'Claude API', ['用你自己的 Anthropic API key，按量计费。key 在上面的“API key”里填。', 'Uses your own Anthropic API key, billed by use. Enter the key under API key above.']],
];
const MODEL_TAGS = { recommended: ['推荐', 'recommended'], top: ['最强', 'most capable'], fast: ['快、省', 'fast, cheap'], older: ['旧版', 'older'] };

// Settings → Assistant: which engine answers in the pane, and with which model.
export function AssistantSettings({ hasKey }) {
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
      <h2><SpeakerIcon size={18} />{t('助手', 'Assistant')}</h2>
      <p className="hint">{info.browser
        ? t('侧边栏里那台留声机，可以开在窗口右边，也可以占满整页。它能查岗位和投递、收藏、记投递、改搜索、开始抓取，改动都可以一键撤销；还能在 Dayjob 浏览器里替你投递：打开投递页、让密码保管在本机登录、填表、附上合适的简历、写求职信。密码和简历原件都不会交给模型，它只知道登录成没成、附的是哪份文件。对话默认不保存。',
          'The gramophone in the sidebar, opened at the right of the window or as a full page. It can look up jobs and applications, save jobs, record applications, change searches and start one, and every change can be undone in one click. It can also apply for you in the Dayjob browser: open the application page, have the vault sign in on this computer, fill in the form, attach the resume that fits and write the cover letter. Passwords and resume files never go to the model; it learns only whether the sign-in worked and which file was attached. Conversations are not saved unless you keep them.')
        : t('侧边栏里那台留声机，可以开在窗口右边，也可以占满整页。它能查岗位和投递、收藏、记投递、改搜索、开始抓取，改动都可以一键撤销；它碰不到密码保管。对话默认不保存。',
          'The gramophone in the sidebar, opened at the right of the window or as a full page. It can look up jobs and applications, save jobs, record applications, change searches and start one, and every change can be undone in one click. It cannot reach the password vault. Conversations are not saved unless you keep them.')}</p>
      <div className="option-row">
        <span>{t('引擎', 'Engine')}</span>
        <div className="segmented" role="group" aria-label={t('助手引擎', 'Assistant engine')}>
          {ENGINES.map(([id, name]) => <button key={id} type="button" className={engine === id ? 'active' : ''} aria-pressed={engine === id} data-fx="lang" onClick={() => assistant.saveSettings({ engine: id })}>{name}</button>)}
        </div>
        <small>{t(...ENGINES.find(([id]) => id === engine)[2])}</small>
      </div>
      <p className={`status-line ${state.available ? 'ok' : 'off'}`}>{state.available ? <CheckCircle2 size={15} /> : null}
        {state.available ? (engine === 'claude-cli' ? t(`已找到 ${state.detail}`, `Found ${state.detail}`) : t('已有 Anthropic API key，可以用', 'An Anthropic API key is set')) : engine === 'claude-cli' ? t('没有找到 Claude Code。请先安装并登录，或在“简历与 AI”里填它的路径。', 'Claude Code was not found. Install it and sign in, or set its path under Resume & AI.')
          : t('还没有 Anthropic API key。', 'There is no Anthropic API key yet.')}</p>
      <div className="option-row">
        <span>{t('模型', 'Model')}</span>
        <Select value={models[engine]} onChange={event => assistant.saveSettings({ models: { [engine]: event.target.value } })}>
          <option value="">{engine === 'claude-cli' ? t('跟随 Claude Code 自己的设置', 'Claude Code\'s own setting') : t(`默认（${defaultName}）`, `Default (${defaultName})`)}</option>
          {info.models.map(item => <option key={item.id} value={item.id}>{item.name}{item.tag ? ` · ${t(...MODEL_TAGS[item.tag])}` : ''}</option>)}
        </Select>
        <small>{t('换引擎或模型后，正在进行的对话会接着聊：Dayjob 把之前的内容交给新的引擎。', 'After a switch, the open conversation carries on: Dayjob hands what was said to the new engine.')}</small>
      </div>
      {info.browser ? (
        <div className="option-row">
          <span>{t('替你投递', 'Applying for you')}</span>
          <ApplySwitch mode={info.settings.apply} bare />
          <small>{info.settings.apply === 'takeover'
            ? t('全权接管：助手自己点“提交”。验证码、付款和只有你知道答案的问题，它仍然会停下来问你。这个开关也在对话框旁边。', 'Full takeover: the assistant clicks “Submit” itself. It still stops and asks at a captcha, a payment, or a question only you can answer. The same switch sits beside the chat box.')
            : t('手动确认：提交之前，对话里会出现一张卡片，按住“投递”才会发出去。这个开关也在对话框旁边。', 'Ask me first: before anything is sent, a card appears in the chat and it goes out only when you hold “Send”. The same switch sits beside the chat box.')}</small>
        </div>
      ) : null}
    </section>
  );
}
