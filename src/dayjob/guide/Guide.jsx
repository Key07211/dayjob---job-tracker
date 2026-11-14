import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ArrowLeft, ArrowRight, BriefcaseBusiness, Building2, Check, MessageCircle, NotebookPen, Search, Send, Settings, SlidersHorizontal, Undo2, X } from 'lucide-react';
import { LanguageSwitch, useI18n } from '../../i18n.jsx';
import { Gramophone } from '../assistant/Gramophone.jsx';
import { assistant, useAssistant } from '../assistant/store.js';
import { EASE, flyTo } from '../groove/fx.js';
import { BEAT, playKey, reducedMotion } from '../groove/sound.js';
import { useMedia } from '../useMedia.js';
import { guide, guideVoice, say, useGuide } from './store.js';
import { dockCard, guideSteps, placeCard, sayTime, settingsSteps, spoken, spotBox } from './steps.js';

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
// The Settings guide is the same card, kept in a column at the right of the window (App makes the page narrower
// for it). It goes down the Settings page one group at a time: the page brings the group up under the light, and
// the card says in plain words what each setting in it does. The wheel still moves the page.
//
// Next and Back, or the arrow keys, move through it; Escape or the cross ends it. Ending the first guide any way
// counts as having seen it, so it does not come by itself again.

const CAN_ICONS = { search: Search, track: BriefcaseBusiness, board: Building2, apply: Send, memory: NotebookPen, undo: Undo2 };
// In a short window the greeting's gramophone is drawn one size smaller, so the card keeps inside the window.
const SHORT_WINDOW = '(max-height: 760px)';
// How far under the top of the page a group of settings comes to rest, and how long the page takes to bring it.
const LEAD = 14;
const GLIDE = BEAT / 2;

const boxesOf = selector => [...document.querySelectorAll(selector)].map(node => node.getBoundingClientRect()).filter(box => box.width >= 1 && box.height >= 1);
const inSight = selector => boxesOf(selector).length > 0;
const sameBox = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const centreOf = box => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
const windowSize = () => ({ width: window.innerWidth, height: window.innerHeight });
const easeInOut = part => (part < 0.5 ? 4 * part ** 3 : 1 - ((-2 * part + 2) ** 3) / 2);
// Where the gramophone lives when it is not showing anyone around.
const home = () => (document.querySelector('.sidebar-foot .assistant-card .gramophone') || document.querySelector('.sidebar-foot .assistant-card'))?.getBoundingClientRect() || null;
// The part of the window that scrolls while the Settings guide is up.
const pageOf = () => document.querySelector('.main-view');
// Where that part has to be scrolled to for a group (its boxes) to rest at the top of it.
function restOf(page, boxes) {
  const top = Math.min(...boxes.map(box => box.top)) - page.getBoundingClientRect().top;
  return Math.max(0, Math.min(page.scrollHeight - page.clientHeight, page.scrollTop + top - LEAD));
}

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
  const { tour, at, scrollY } = useGuide();
  // paged: the Settings guide, whose card keeps to its column while the page moves under the light.
  const paged = tour === 'settings';
  const short = useMedia(SHORT_WINDOW);
  const steps = useMemo(() => {
    if (!paged) return guideSteps({ browser: hasBrowser });
    // Only the groups this Settings page shows (the desktop app has more of them than the page in a web browser).
    const all = settingsSteps({ browser: hasBrowser });
    const shown = all.filter(item => document.querySelector(item.target[0]));
    return shown.length ? shown : all;
  }, [paged, hasBrowser]);
  const [index, setIndex] = useState(() => (paged ? Math.max(0, steps.findIndex(item => item.id === at)) : 0));
  const [speaking, setSpeaking] = useState(false);
  const [rush, setRush] = useState(false);
  const [box, setBox] = useState(null);         // { spot, left, top, tail } once the card has been measured
  const [leaving, setLeaving] = useState(false);
  const [gliding, setGliding] = useState(false);
  const [, setResized] = useState(0);
  const card = useRef(null);
  const forward = useRef(null);
  const back = useRef(startView);
  const entered = useRef(false);
  // Where the lit group of settings rests once the page has brought it up. The card stands level with that, and
  // stays there while the page is on its way and while the user turns the wheel.
  const rest = useRef(null);
  const still = reducedMotion();
  const step = steps[index];
  const intro = !paged && index === 0;
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
    const view = windowSize();
    const size = { width: node.offsetWidth, height: node.offsetHeight };
    const spot = spotBox((step.target || []).flatMap(boxesOf), view);
    const next = { spot, ...(paged ? dockCard({ spot: rest.current || spot, card: size, view }) : placeCard({ spot, card: size, view })) };
    setBox(current => (sameBox(current, next) ? current : next));
  }, [step, paged]);

  // The Settings guide: a step begins by bringing its group up to the top of the page. The first one is there at
  // once (the card has not stepped out yet); after that the page takes half a beat, the light riding with the group.
  useLayoutEffect(() => {
    if (!paged) return undefined;
    const page = pageOf();
    if (!page) { rest.current = null; return undefined; }
    // Until now the page scrolled with the window; the part that scrolls takes over from where that was.
    if (!entered.current && scrollY && !page.scrollTop) page.scrollTop = scrollY;
    const boxes = step.target.flatMap(boxesOf);
    if (!boxes.length) { rest.current = null; return undefined; }
    const from = page.scrollTop;
    const to = restOf(page, boxes);
    rest.current = spotBox(boxes.map(item => ({ left: item.left, right: item.right, top: item.top - (to - from), bottom: item.bottom - (to - from) })), windowSize());
    if (still || !entered.current || Math.abs(to - from) < 1) { page.scrollTop = to; return undefined; }
    let raf = 0, began = 0;
    setGliding(true);
    const frame = now => {
      began ||= now;
      const part = Math.min(1, (now - began) / GLIDE);
      page.scrollTop = from + (to - from) * easeInOut(part);
      measure();
      if (part < 1) raf = requestAnimationFrame(frame); else setGliding(false);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); setGliding(false); };
  }, [index, paged]);   // only the step

  // After every render: the card's size follows its words, and its place follows its size.
  useLayoutEffect(measure);
  useEffect(() => {
    const resized = () => {
      // A group of settings goes back to its place, at the window's new size.
      const page = paged ? pageOf() : null;
      const boxes = page ? step.target.flatMap(boxesOf) : [];
      if (boxes.length) {
        page.scrollTop = restOf(page, boxes);
        rest.current = spotBox(step.target.flatMap(boxesOf), windowSize());
      }
      measure();
      setResized(value => value + 1);
    };
    window.addEventListener('resize', resized);
    const sizes = 'ResizeObserver' in window ? new ResizeObserver(measure) : null;
    if (card.current) sizes?.observe(card.current);
    // The sidebar's own parts can move while the guide is up (an update appears, a search starts).
    const timer = setInterval(measure, 500);
    return () => { window.removeEventListener('resize', resized); sizes?.disconnect(); clearInterval(timer); };
  }, [measure, paged, step]);

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

  // The Settings guide is about the Settings page, wherever it was asked for.
  useEffect(() => { if (paged && startView !== 'settings') goTo('settings'); }, []);
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
  // takes the user somewhere else). The Settings guide leaves the page as the user has it, where it has been
  // scrolled to.
  const finish = useCallback(({ then = null } = {}) => {
    if (leaving) return;
    if (!paged) guide.markSeen();
    const done = () => {
      const kept = paged ? pageOf()?.scrollTop || 0 : 0;
      // At once, so the page scrolls with the window again before it is put back where it was.
      flushSync(() => guide.stop());
      if (then) then(); else if (!paged) goTo(back.current);
      if (kept && !pageOf()?.scrollTop) window.scrollTo(0, kept);
    };
    const node = card.current;
    const to = home();
    if (still || !node || !to) { done(); return; }
    setLeaving(true);
    const from = centreOf(node.getBoundingClientRect());
    const b = centreOf(to);
    node.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${b.x - from.x}px, ${b.y - from.y}px) scale(.08)`, opacity: 0 }], { duration: BEAT / 2, easing: EASE.inout, fill: 'forwards' });
    setTimeout(done, BEAT / 2);
  }, [leaving, still, goTo, paged]);

  const next = useCallback(() => {
    if (leaving) return;
    if (!paged) guide.markSeen();
    if (last) finish(); else setIndex(value => value + 1);
  }, [leaving, last, finish, paged]);
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

  // The wheel moves the Settings page under the light (the page itself cannot be reached while the guide is up).
  const onWheel = event => {
    const page = paged && !event.target.closest?.('.guide-card') ? pageOf() : null;
    if (!page) return;
    page.scrollTop += event.deltaY;
    measure();
  };

  const spot = box?.spot;
  const spotStyle = spot ? { left: spot.left, top: spot.top, width: spot.width, height: spot.height }
    : { left: Math.round(window.innerWidth / 2), top: Math.round(window.innerHeight / 2), width: 0, height: 0 };
  const tailed = box && box.tail !== null;
  const count = paged ? steps.length : steps.length - 1;
  const note = step.foot || step.note;
  return (
    <div className={`guide${leaving ? ' leaving' : ''}${gliding ? ' gliding' : ''}`} role="dialog" aria-modal="true" aria-labelledby="guide-title" onWheel={onWheel}>
      <div className={`guide-spot${spot ? '' : ' none'}`} style={spotStyle} aria-hidden="true" />
      <section ref={card} className={`guide-card${intro ? ' intro' : ''}${paged ? ' docked' : ''}${box ? ' placed' : ''}${tailed ? ' tailed' : ''}`}
        style={box ? { left: box.left, top: box.top, '--tail': tailed ? `${box.tail}px` : undefined } : undefined}>
        <header className="guide-head">
          <Gramophone key={scale} phase={speaking ? 'speaking' : 'idle'} scale={scale} strip voice={guideVoice} label={t('助手留声机', 'Assistant gramophone')} />
          <div className="guide-title">
            {intro ? null : <small>{paged ? t(`设置讲解 · ${index + 1} / ${count}`, `Settings explained · ${index + 1} of ${count}`) : t(`第 ${index} 步，共 ${count} 步`, `Step ${index} of ${count}`)}</small>}
            <h2 id="guide-title">{t(...step.title)}</h2>
          </div>
          {/* The greeting can come before anyone has chosen a language, so the switch is on it. */}
          {intro ? <LanguageSwitch compact />
            : <button type="button" className="icon-button" title={t('结束引导', 'End the guide')} aria-label={t('结束引导', 'End the guide')} onClick={() => finish()}><X size={18} /></button>}
        </header>
        <div className="guide-body" key={index} onClick={() => setRush(true)}>
          <Spoken key={`${lang}|${lines.join('|')}`} lines={lines} lang={lang} instant={still} rush={rush} onSpeaking={setSpeaking} />
          {step.can ? (
            <ul className="guide-can">
              {step.can.map(item => { const Icon = CAN_ICONS[item.icon]; return <li key={item.icon}><Icon size={15} /><span>{t(...item.text)}</span></li>; })}
            </ul>
          ) : null}
          {step.lead ? <p className="guide-lead">{t(...step.lead)}</p> : null}
          {step.terms?.length ? (
            <dl className="guide-terms">
              {step.terms.map(item => <div key={item.name[1]}><dt>{t(...item.name)}</dt><dd>{t(...item.means)}</dd></div>)}
            </dl>
          ) : null}
          {step.where?.length ? (
            <div className="guide-where">
              <strong><SlidersHorizontal size={13} />{t('在哪里改', 'Where to change it')}</strong>
              <ul>{step.where.map(item => <li key={item.at[1]}><span>{t(...item.what)}</span><em>{t(...item.at)}</em></li>)}</ul>
            </div>
          ) : null}
        </div>
        <footer className={`guide-foot${intro ? ' intro' : ''}${last && !paged ? ' last' : ''}`}>
          {intro ? (
            <>
              <button type="button" className="button" onClick={() => finish()}>{t('先不用', 'Not now')}</button>
              <button type="button" className="button primary" ref={forward} onClick={next}>{t('带我看一遍', 'Show me around')}<ArrowRight size={15} /></button>
            </>
          ) : (
            <>
              {paged ? null : <ol className="guide-dots" aria-hidden="true">{steps.slice(1).map((item, order) => <li key={item.id} className={order + 1 < index ? 'done' : order + 1 === index ? 'now' : ''} />)}</ol>}
              {paged && index === 0 ? null : <button type="button" className="button" onClick={previous}><ArrowLeft size={15} />{t('上一步', 'Back')}</button>}
              {last && !paged && state === 'ready' ? <button type="button" className="button" onClick={() => finish({ then: () => { goTo(back.current); assistant.setForm('side'); } })}><MessageCircle size={15} />{t('和助手说句话', 'Say hello')}</button> : null}
              {last && !paged && state !== 'ready' ? <button type="button" className="button" onClick={() => finish({ then: () => openItem('settings', state === 'no-key' ? 'api-keys' : 'assistant') })}><Settings size={15} />{t('去设置', 'Open Settings')}</button> : null}
              <button type="button" className="button primary" ref={forward} onClick={next}>{last ? <>{t('完成', 'Done')}<Check size={15} /></> : <>{t('下一步', 'Next')}<ArrowRight size={15} /></>}</button>
            </>
          )}
        </footer>
        {note ? <p className="guide-note">{t(...note)}</p> : null}
        <p className="guide-sr" aria-live="polite">{[...lines, ...(step.terms || []).map(item => `${t(...item.name)}: ${t(...item.means)}`)].join(' ')}</p>
      </section>
    </div>
  );
}
