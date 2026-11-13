import { useEffect } from 'react';
import { useI18n } from '../../i18n.jsx';
import { APPLY_STEPS, applyRun } from './apply.js';
import { Gramophone } from './Gramophone.jsx';
import { assistant, useAssistant } from './store.js';

// The assistant's own place in the sidebar: its gramophone, its name, and the two ways to talk with it: a small
// chat at the side of the window, or the whole page. The form that is open is lit; pressing it again closes the
// chat. While the chat is closed the gramophone here moves with a reply that is still coming. What it is doing is
// written only while it is doing something; at rest the card says nothing more than its name.
//
// form is what the window shows (a full-page chat docks at the side when the browser takes the page); asking is
// true while a question waits for the user before something is sent.
export function AssistantCard({ form, asking = false, onForm }) {
  const { t } = useI18n();
  const { conversation, busy, phase } = useAssistant();
  useEffect(() => { void assistant.refresh(); }, []);
  const turns = conversation?.turns || [];
  const run = applyRun(turns);
  const applying = run && run.turn >= turns.length - 3 && run.reached < APPLY_STEPS.indexOf('record') && (busy || asking);
  const state = asking ? t('等你确认', 'Waiting for you')
    : applying ? t(`正在投递 ${Math.min(run.reached + 2, APPLY_STEPS.length)}/${APPLY_STEPS.length}`, `Applying ${Math.min(run.reached + 2, APPLY_STEPS.length)}/${APPLY_STEPS.length}`)
      : phase === 'thinking' ? t('在想…', 'Thinking…') : phase === 'speaking' ? t('在回答…', 'Answering…') : phase === 'tool' ? t('在操作…', 'Working…') : '';
  const toggle = wanted => onForm(form === wanted ? 'closed' : wanted);
  return (
    <section className={`assistant-card${form !== 'closed' ? ' on' : ''}${busy ? ' busy' : ''}${asking ? ' asking' : ''}${state ? ' stated' : ''}`} aria-label={t('助手', 'Assistant')}>
      <button type="button" className="assistant-card-face" title={form === 'closed' ? t('打开助手', 'Open the assistant') : undefined} onClick={() => { if (form === 'closed') onForm('side'); }}>
        <Gramophone phase={form === 'closed' ? phase : 'idle'} scale={1} live={form === 'closed'} label={t('助手留声机', 'Assistant gramophone')} />
        <span className="assistant-card-text">
          <strong>{t('助手', 'Assistant')}</strong>
          <small aria-live="polite" title={applying && run.job ? run.job : undefined}>{state}</small>
        </span>
      </button>
      <div className="assistant-card-forms" role="group" aria-label={t('助手的两种形态', 'Two ways to open the assistant')}>
        <button type="button" className={form === 'side' ? 'active' : ''} aria-pressed={form === 'side'} onClick={() => toggle('side')}>{t('小对话', 'Side chat')}</button>
        <button type="button" className={form === 'full' ? 'active' : ''} aria-pressed={form === 'full'} onClick={() => toggle('full')}>{t('全屏', 'Full page')}</button>
      </div>
    </section>
  );
}
