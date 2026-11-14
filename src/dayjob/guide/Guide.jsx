import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowRight, BriefcaseBusiness, Building2, Check, MessageCircle, NotebookPen, Search, Send, Settings, SlidersHorizontal, Undo2, X } from 'lucide-react';
import { useI18n } from '../../i18n.jsx';
import { Gramophone } from '../assistant/Gramophone.jsx';
import { assistant, useAssistant } from '../assistant/store.js';
import { EASE, flyTo } from '../groove/fx.js';
import { BEAT, playKey, reducedMotion } from '../groove/sound.js';
import { guide, guideVoice, say } from './store.js';
import { guideSteps, placeCard, sayTime, spoken, spotBox } from './steps.js';

// The user guide. The first time Dayjob opens, once the opening has played, the assistant's gramophone steps out
// of its place in the sidebar, says who it is and what it can do, and then shows the user around: it goes from page
// to page, lights the thing it is talking about, says what it is for and where its settings are. The same guide can
// be asked for again from Settings and from the assistant's own page.
//
// It is one card that speaks. For the greeting it stands in the middle of the window; after that it stands beside
// the sidebar, level with whatever is lit, and a note flies from its horn to each page's key as the page comes
// forward. The words come out over a moment while the gramophone plays them and then stand still; nothing moves
// while it waits for the user. The rest of the window cannot be clicked meanwhile (App makes it inert).
//
// Next and Back, or the arrow keys, move through it; Escape or the cross ends it. Ending it any way counts as
// having seen it, so it does not come by itself again.

const CAN_ICONS = { search: Search, track: BriefcaseBusiness, board: Building2, apply: Send, memory: NotebookPen, undo: Undo2 };
// In a short window the greeting's gramophone is drawn one size smaller, so the card keeps inside the window.
const SHORT_WINDOW = '(max-height: 760px)';
const watchShort = notify => { const query = window.matchMedia(SHORT_WINDOW); query.addEventListener('change', notify); return () => query.removeEventListener('change', notify); };
const useShortWindow = () => useSyncExternalStore(watchShort, () => window.matchMedia(SHORT_WINDOW).matches, () => false);

const boxOf = selector => document.querySelector(selector)?.getBoundingClientRect() || null;
const inSight = selector => { const box = boxOf(selector); return Boolean(box && box.width >= 1 && box.height >= 1); };
const sameBox = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const centreOf = box => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
// Where the gramophone lives when it is not showing anyone around.
const home = () => boxOf('.sidebar-foot .assistant-card .gramophone') || boxOf('.sidebar-foot .assistant-card');

// The assistant saying a step. All of the text takes its room from the start (what has not been said yet is there
// but unseen), so the card does not grow or move as the words come. rush says the rest at once.
function Spoken({ lines, lang, instant, rush, onSpeaking }) {
  const total = lines.reduce((sum, line) => sum + line.length, 0);
  const [count, setCount] = useState(instant ? total : 0);
  const hurry = useRef(rush);
  hurry.current = rush;
  useEffect(() => {
    if (instant || !total) return undefined;
    const time = lines.reduce((sum, line) => sum + sayTime(line, lang), 0);
    const text = lines.join('');
    let raf = 0, started = 0, said = 0, heardAt = 0;
    onSpeaking(true);
    const tick = now => {
      started ||= now;
      const upTo = hurry.current ? total : Math.min(total, Math.floor((now - started) / time * total));
      // The gramophone hears the words in small pieces, the way a reply's words arrive.
      if (upTo > said && (now - heardAt >= 110 || upTo === total)) { if (!hurry.current) say(text.slice(said, upTo)); said = upTo; heardAt = now; }
      setCount(upTo);
      if (upTo >= total) { onSpeaking(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); onSpeaking(false); };
  }, []);   // one saying per mount: the card gives each step, and each language, its own
  let left = rush ? total : count;
  return (
    <div className="guide-said" aria-hidden="true">
      {lines.map((line, index) => {
        const shown = Math.max(0, Math.min(line.length, left));
        left -= line.length;
        return <p key={index}>{line.slice(0, shown)}{shown < line.length ? <span className="guide-unsaid">{line.slice(shown)}</span> : null}</p>;
      })}
    </div>
  );
}

// views: the sidebar's pages (id, note); startView: the page showing when the guide began, which comes back when it
// ends; goTo / openItem: App's ways of changing the page; hasBrowser: whether this Dayjob has its own browser.
export function Guide({ views, startView, goTo, openItem, theme, hasBrowser }) {
  const { t, lang } = useI18n();
  const { info } = useAssistant();
  const short = useShortWindow();
  const steps = useMemo(() => guideSteps({ browser: hasBrowser }), [hasBrowser]);
  const [index, setIndex] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [rush, setRush] = useState(false);
  const [box, setBox] = useState(null);         // { spot, left, top, tail } once the card has been measured
  const [leaving, setLeaving] = useState(false);
  const [, setResized] = useState(0);
  const card = useRef(null);
  const forward = useRef(null);
  const back = useRef(startView);
  const entered = useRef(false);
  const still = reducedMotion();
  const step = steps[index];
  const intro = index === 0;
  const last = index === steps.length - 1;
  const scale = intro && !short ? 3 : 2;

  // Whether the assistant can answer yet, for what it says about itself at the end.
  const engine = info?.settings.engine;
  const ready = !engine || !info.engines[engine] || info.engines[engine].available;
  const state = ready ? 'ready' : engine === 'claude-cli' ? 'no-cli' : 'no-key';
  const lines = spoken(step, lang, { seen: inSight, state });

  const measure = useCallback(() => {
    const node = card.current;
    if (!node) return;
    const view = { width: window.innerWidth, height: window.innerHeight };
    const spot = spotBox((step.target || []).map(boxOf), view);
    const next = { spot, ...placeCard({ spot, card: { width: node.offsetWidth, height: node.offsetHeight }, view }) };
    setBox(current => (sameBox(current, next) ? current : next));
  }, [step]);
  // After every render: the card's size follows its words, and its place follows its size.
  useLayoutEffect(measure);
  useEffect(() => {
    const resized = () => { measure(); setResized(value => value + 1); };
    window.addEventListener('resize', resized);
    const sizes = 'ResizeObserver' in window ? new ResizeObserver(measure) : null;
    if (card.current) sizes?.observe(card.current);
    // The sidebar's own parts can move while the guide is up (an update appears, a search starts).
    const timer = setInterval(measure, 500);
    return () => { window.removeEventListener('resize', resized); sizes?.disconnect(); clearInterval(timer); };
  }, [measure]);

  // It steps out of its place in the sidebar, in one hop.
  useLayoutEffect(() => {
    if (!box || entered.current) return;
    entered.current = true;
    const node = card.current;
    const from = home();
    if (still || !node || !from) return;
    const a = centreOf(from);
    const dx = a.x - (box.left + node.offsetWidth / 2);
    const dy = a.y - (box.top + node.offsetHeight / 2);
    node.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(.08)`, opacity: 0 },
      { transform: `translate(${dx * 0.42}px, ${dy * 0.42 - 70}px) scale(.62)`, opacity: 1, offset: 0.5 },
      { transform: 'translate(0, 0) scale(1.03)', opacity: 1, offset: 0.86 },
      { transform: 'none', opacity: 1 },
    ], { duration: BEAT, easing: EASE.out });
  }, [box, still]);

  // A step begins: its page comes forward, and a note goes from the horn to the page's key, which sounds.
  useEffect(() => {
    if (step.view) goTo(step.view);
    if (step.key) {
      flyTo(card.current?.querySelector('.gram-mouth'), step.key);
      playKey(views.find(item => item.id === step.key)?.note ?? 0, theme);
    }
    setRush(false);
  }, [index]);   // only the step: a change of theme or language does not replay it
  // The way forward has the keyboard, from the moment the card can be seen.
  const placed = Boolean(box);
  useEffect(() => { if (placed) forward.current?.focus({ preventScroll: true }); }, [index, placed]);

  // Ends the guide: the card goes back into the sidebar, and the page that was showing comes back (unless `then`
  // takes the user somewhere else).
  const finish = useCallback(({ then = null } = {}) => {
    if (leaving) return;
    guide.markSeen();
    const done = () => {
      guide.stop();
      if (then) then(); else goTo(back.current);
    };
    const node = card.current;
    const to = home();
    if (still || !node || !to) { done(); return; }
    setLeaving(true);
    const at = centreOf(node.getBoundingClientRect());
    const b = centreOf(to);
    node.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${b.x - at.x}px, ${b.y - at.y}px) scale(.08)`, opacity: 0 }], { duration: BEAT / 2, easing: EASE.inout, fill: 'forwards' });
    setTimeout(done, BEAT / 2);
  }, [leaving, still, goTo]);

  const next = useCallback(() => {
    if (leaving) return;
    guide.markSeen();
    if (last) finish(); else setIndex(value => value + 1);
  }, [leaving, last, finish]);
  const previous = useCallback(() => { if (!leaving) setIndex(value => Math.max(0, value - 1)); }, [leaving]);

  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); finish(); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); next(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); previous(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [finish, next, previous]);

  const spot = box?.spot;
  const spotStyle = spot ? { left: spot.left, top: spot.top, width: spot.width, height: spot.height }
    : { left: Math.round(window.innerWidth / 2), top: Math.round(window.innerHeight / 2), width: 0, height: 0 };
  const tailed = box && box.tail !== null;
  const count = steps.length - 1;
  return (
    <div className={`guide${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby="guide-title">
      <div className={`guide-spot${spot ? '' : ' none'}`} style={spotStyle} aria-hidden="true" />
      <section ref={card} className={`guide-card${intro ? ' intro' : ''}${box ? ' placed' : ''}${tailed ? ' tailed' : ''}`}
        style={box ? { left: box.left, top: box.top, '--tail': tailed ? `${box.tail}px` : undefined } : undefined}>
        <header className="guide-head">
          <Gramophone key={scale} phase={speaking ? 'speaking' : 'idle'} scale={scale} strip voice={guideVoice} label={t('助手留声机', 'Assistant gramophone')} />
          <div className="guide-title">
            {intro ? null : <small>{t(`第 ${index} 步，共 ${count} 步`, `Step ${index} of ${count}`)}</small>}
            <h2 id="guide-title">{t(...step.title)}</h2>
          </div>
          {intro ? null : <button type="button" className="icon-button" title={t('结束引导', 'End the guide')} aria-label={t('结束引导', 'End the guide')} onClick={() => finish()}><X size={18} /></button>}
        </header>
        <div className="guide-body" key={index} onClick={() => setRush(true)}>
          <Spoken key={`${lang}|${lines.join('|')}`} lines={lines} lang={lang} instant={still} rush={rush} onSpeaking={setSpeaking} />
          {step.can ? (
            <ul className="guide-can">
              {step.can.map(item => { const Icon = CAN_ICONS[item.icon]; return <li key={item.icon}><Icon size={15} /><span>{t(...item.text)}</span></li>; })}
            </ul>
          ) : null}
          {step.lead ? <p className="guide-lead">{t(...step.lead)}</p> : null}
          {step.where?.length ? (
            <div className="guide-where">
              <strong><SlidersHorizontal size={13} />{t('在哪里改', 'Where to change it')}</strong>
              <ul>{step.where.map(item => <li key={item.at[1]}><span>{t(...item.what)}</span><em>{t(...item.at)}</em></li>)}</ul>
            </div>
          ) : null}
        </div>
        <footer className={`guide-foot${intro ? ' intro' : ''}${last ? ' last' : ''}`}>
          {intro ? (
            <>
              <button type="button" className="button" onClick={() => finish()}>{t('先不用', 'Not now')}</button>
              <button type="button" className="button primary" ref={forward} onClick={next}>{t('带我看一遍', 'Show me around')}<ArrowRight size={15} /></button>
            </>
          ) : (
            <>
              <ol className="guide-dots" aria-hidden="true">{steps.slice(1).map((item, at) => <li key={item.id} className={at + 1 < index ? 'done' : at + 1 === index ? 'now' : ''} />)}</ol>
              <button type="button" className="button" onClick={previous}><ArrowLeft size={15} />{t('上一步', 'Back')}</button>
              {last && state === 'ready' ? <button type="button" className="button" onClick={() => finish({ then: () => { goTo(back.current); assistant.setForm('side'); } })}><MessageCircle size={15} />{t('和助手说句话', 'Say hello')}</button> : null}
              {last && state !== 'ready' ? <button type="button" className="button" onClick={() => finish({ then: () => openItem('settings', state === 'no-key' ? 'api-keys' : 'assistant') })}><Settings size={15} />{t('去设置', 'Open Settings')}</button> : null}
              <button type="button" className="button primary" ref={forward} onClick={next}>{last ? <>{t('完成', 'Done')}<Check size={15} /></> : <>{t('下一步', 'Next')}<ArrowRight size={15} /></>}</button>
            </>
          )}
        </footer>
        {step.foot ? <p className="guide-note">{t(...step.foot)}</p> : null}
        <p className="guide-sr" aria-live="polite">{lines.join(' ')}</p>
      </section>
    </div>
  );
}
