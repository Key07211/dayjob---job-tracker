import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkGlyph } from './MarkGlyph.jsx';
import { prefs } from './prefs.js';
import { BEAT, reducedMotion } from './sound.js';
import { EASE } from './fx.js';

// The opening (the 打开动画 board): when Dayjob's window first opens, the day's search plays as a short groove, one
// card for each new job.
// Day, two beats at 96 BPM: the icon drops in, the cards fly in from the right and each lands as a bar, the bars hop
// on beat two and glide into the header while the icon becomes the sidebar's logo and the sidebar slides in, its keys
// pressed one after another.
// Night, slower (72 BPM) and without bounce: a desk lamp comes on, the needle drops, the cards fall along the light
// as warm bars, the record goes back into the sidebar, the keys light one by one and the lamp's light stays as the
// page's glow.
// A click or a key skips it. It plays once per window (not after a reload, nor when the window comes back from the
// tray), only when the window is shown soon after it loads, and never when Windows asks for reduced motion.
const LENGTH = { day: BEAT * 2 + 50, night: 1500 };
const MAX_CARDS = 8;
const HERO = 96;
const DECK = 132;
const BACK = 'cubic-bezier(.3, 1.45, .5, 1)';
const FALL = 'cubic-bezier(.45, 0, 1, .7)';
const GRAVITY = 'cubic-bezier(.5, 0, 1, 1)';
// What each card becomes: a bar this tall (px); the tallest of them is lit.
const ROW_H = [36, 55, 46, 70, 53, 79, 60, 48];
// [width, height, corner] of a card.
const CARD = { day: [120, 38, 10], night: [84, 30, 8] };
const BAR_W = { day: 14, night: 12 };
// How long the window may take to be shown and the first data to arrive before the opening gives up.
const WAIT = 2500;

const SEEN = 'dayjob-opened';
function firstOpen() {
  if (typeof window === 'undefined' || reducedMotion() || prefs.get().opening === false) return false;
  try {
    if (sessionStorage.getItem(SEEN)) return false;
    sessionStorage.setItem(SEEN, '1');
    return true;
  } catch { return false; }
}
let playing = firstOpen();
// Whether the opening is (still) going to bring the sidebar's logo in, so the logo skips its own arrival.
export const openingPlays = () => playing;

const px = value => `${Math.round(value * 10) / 10}px`;
const move = (x, y, scale = 1) => `translate(${px(x)}, ${px(y)}) scale(${scale})`;
const sway = (deg, x, y, scale = 1) => `translate(${px(x)}, ${px(y)}) rotate(${deg}deg) scale(${scale})`;
const box = el => {
  const r = el?.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0 ? r : null;
};
// points: [[ms, properties, easing to the next point], ...] over the whole opening, one animation per element, so no
// two animations fight over a property. Before the first point and after the last the element holds still.
function keyframes(points, total) {
  const frames = points.map(([ms, props, easing]) => ({ ...props, offset: Math.min(1, Math.max(0, ms / total)), easing: easing || 'linear' }));
  if (frames[0].offset > 0) frames.unshift({ ...frames[0], offset: 0, easing: 'linear' });
  if (frames[frames.length - 1].offset < 1) frames.push({ ...frames[frames.length - 1], offset: 1, easing: 'linear' });
  return frames;
}

// Where everything starts and lands, from the page as it is drawn now (window px), and the page's parts that move.
function measure(night, newJobs) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const n = Math.max(0, Math.min(MAX_CARDS, Math.floor(Number(newJobs)) || 0));
  const section = document.querySelector('.main-view > section') || document.querySelector('.main-view');
  const header = section?.querySelector(':scope > .view-header') || null;
  const parts = {
    section,
    sidebar: document.querySelector('.app-shell > .sidebar'),
    brand: document.querySelector('.sidebar .brand-mark'),
    keys: [...document.querySelectorAll('.sidebar .pkey')],
    header,
    blocks: section ? [...section.children].filter(child => child !== header) : [],
    vinyl: [document.querySelector('.turntable .vinyl'), document.querySelector('.minirec .mini-disc')].find(box) || null,
  };
  // The bars end in the header's wave, spread along it.
  const slot = box(header?.querySelector('.wave-slot')) || box(header);
  const line = slot ? { left: slot.left, width: slot.width, y: slot.top + slot.height * 0.6 } : { left: W * 0.4, width: W * 0.3, y: 80 };
  const landing = i => ({ x: line.left + ((i + 0.5) / n) * line.width, y: line.y });
  let peak = 0;
  for (let i = 1; i < n; i += 1) if (ROW_H[i] > ROW_H[peak]) peak = i;
  const brand = box(parts.brand);
  const logo = brand ? { x: brand.left + brand.width / 2, y: brand.top + brand.height / 2, size: brand.width } : { x: 48, y: 38, size: 32 };
  if (!night) {
    const hero = { x: W / 2, y: Math.round(H * 0.42) };
    const base = hero.y + 140;
    const bars = Array.from({ length: n }, (_, i) => ({ x: W / 2 + (i - (n - 1) / 2) * 26, base, h: ROW_H[i], peak: i === peak,
      from: { x: W + 90, y: base - 70 + (i % 3) * 44 }, to: landing(i) }));
    return { scene: { night, n, W, H, hero, logo, bars }, parts };
  }
  const lamp = { x: Math.round(W * 0.3), mouth: 50 };
  const deck = { x: lamp.x, y: Math.round(H * 0.6) };
  const spread = Math.round((H - lamp.mouth) * 0.48);
  const disc = box(parts.vinyl);
  const vinyl = disc ? { x: disc.left + disc.width / 2, y: disc.top + disc.height / 2, size: disc.width } : { x: 108, y: H - 120, size: 100 };
  const bars = Array.from({ length: n }, (_, i) => ({ x: deck.x + 110 + i * 20, base: deck.y + 66, h: ROW_H[i], peak: i === peak,
    from: { x: lamp.x + ((i % 3) - 1) * 12, y: lamp.mouth + 34 }, mid: { x: lamp.x + 30 + i * 12, y: (lamp.mouth + deck.y) / 2 + 40 }, to: landing(i) }));
  return { scene: { night, n, W, H, lamp, deck, spread, logo, vinyl, bars }, parts };
}

// Each returns the timeline of the page's j-th block of content, for content that arrives while it plays.
function playDay({ scene: g, parts: p, all, play }) {
  const total = LENGTH.day;
  const [cw, ch, cr] = CARD.day;
  const bw = BAR_W.day;
  const at = (el, points, own) => play(el, points, total, own);
  at(all('.op-ground')[0], [[690, { opacity: 1 }], [790, { opacity: 0 }]]);
  at(all('.op-sun')[0], [[0, { opacity: 0, transform: 'scale(.4)' }, EASE.out], [600, { opacity: 1, transform: 'scale(1.1)' }, EASE.inout], [1000, { opacity: 0, transform: 'scale(1.2)' }]]);
  // The icon lands on the half beat, bounces its bars, then flies into the sidebar as its logo.
  const toLogo = move(g.logo.x - g.hero.x, g.logo.y - g.hero.y, g.logo.size / HERO);
  at(all('.op-hero')[0], [[0, { opacity: 0, transform: move(0, -220) }, BACK], [312, { opacity: 1, transform: move(0, 0) }], [705, { opacity: 1, transform: move(0, 0) }, EASE.inout],
    [985, { opacity: 1, transform: toLogo }], [1025, { opacity: 0, transform: toLogo }]]);
  all('.op-hero .mk-bar').forEach((bar, i) => {
    const t = 330 + i * 45;
    at(bar, [[t, { transform: 'scaleY(1)' }, EASE.inout], [t + 90, { transform: 'scaleY(1.3)' }, EASE.inout], [t + 190, { transform: 'scaleY(.8)' }, EASE.inout], [t + 290, { transform: 'scaleY(1)' }]]);
  });
  // The cards fly in from the right and land as bars, all by the second beat; they hop on it and glide into the header.
  const gap = g.n > 1 ? Math.min(45, 220 / (g.n - 1)) : 0;
  const wraps = all('.op-bw');
  g.bars.forEach((bar, i) => {
    const t0 = 150 + i * gap;
    const t1 = t0 + 230;
    const g0 = BEAT + i * 10;
    const g1 = g0 + 300;
    at(wraps[i], [[t0, { transform: move(bar.from.x - bar.x, bar.from.y - bar.base) }, EASE.out], [t1, { transform: move(0, 0) }], [g0, { transform: move(0, 0) }, EASE.out],
      [g0 + 90, { transform: move(0, -20) }, EASE.inout], [g1, { transform: move(bar.to.x - bar.x, bar.to.y - bar.base, 0.42) }]]);
    const card = { width: px(cw), height: px(ch), borderRadius: px(cr), backgroundColor: g.colors.card };
    const stick = { width: px(bw), height: px(bar.h), borderRadius: px(bw / 2), backgroundColor: bar.peak ? g.colors.peak : g.colors.bar };
    at(wraps[i]?.firstElementChild, [[t0, { opacity: 0, ...card }], [t0 + 50, { opacity: 1, ...card }], [t0 + 150, { opacity: 1, ...card }, EASE.out], [t1, { opacity: 1, ...stick }],
      [g0 + 200, { opacity: 1, ...stick }], [g1, { opacity: 0, ...stick }]]);
  });
  // The page under it: the sidebar slides in and its keys go down and up in turn, a silent glissando; then the header
  // and the page's content.
  at(p.sidebar, [[700, { transform: 'translateX(-100%)' }, EASE.out], [940, { transform: 'none' }]], false);
  at(p.brand, [[985, { opacity: 0 }], [1000, { opacity: 1 }]], false);
  p.keys.forEach((key, i) => {
    const t = 760 + i * 40;
    at(key, [[t, { transform: 'none', filter: 'none' }, EASE.out], [t + 70, { transform: 'translateY(3px)', filter: 'brightness(.93)' }, EASE.inout], [t + 170, { transform: 'none', filter: 'none' }]], false);
  });
  at(p.header, [[960, { opacity: 0, transform: 'translateY(10px)' }, EASE.out], [1160, { opacity: 1, transform: 'none' }]], false);
  const block = j => {
    const t = 1000 + Math.min(j, 5) * 30;
    return [[t, { opacity: 0, transform: 'translateY(12px)' }, EASE.out], [t + 190, { opacity: 1, transform: 'none' }]];
  };
  p.blocks.forEach((el, j) => at(el, block(j), false));
  return block;
}

function playNight({ scene: g, parts: p, all, play }) {
  const total = LENGTH.night;
  const [cw, ch, cr] = CARD.night;
  const bw = BAR_W.night;
  const at = (el, points, own) => play(el, points, total, own);
  at(all('.op-ground')[0], [[880, { opacity: 1 }], [980, { opacity: 0 }]]);
  // The lamp's glow is the page's own (body's) glow: it comes on with the lamp and hands over to the page's.
  at(all('.op-glow')[0], [[200, { opacity: 0 }, EASE.inout], [800, { opacity: 1 }], [880, { opacity: 1 }], [980, { opacity: 0 }]]);
  // The lamp comes on with one small flicker (no strobe) and lays a pool of light on the desk.
  at(all('.op-lamp')[0], [[0, { opacity: 0, transform: 'translateY(-20px)' }, EASE.out], [200, { opacity: 1, transform: 'none' }], [1100, { opacity: 1, transform: 'none' }, EASE.inout],
    [1400, { opacity: 0, transform: 'none' }]]);
  at(all('.op-cone')[0], [[160, { opacity: 0 }], [240, { opacity: 0.75 }], [290, { opacity: 0.45 }, EASE.inout], [420, { opacity: 1 }], [1100, { opacity: 1 }, EASE.inout], [1400, { opacity: 0 }]]);
  at(all('.op-pool')[0], [[220, { opacity: 0, transform: 'scale(.3)' }, EASE.out], [620, { opacity: 1, transform: 'scale(1)' }], [1100, { opacity: 1, transform: 'scale(1)' }, EASE.inout],
    [1400, { opacity: 0, transform: 'scale(1.1)' }]]);
  // Under the lamp the needle drops and the record turns; then the player shrinks into the sidebar's record.
  const home = move(g.vinyl.x - g.deck.x, g.vinyl.y - g.deck.y, g.vinyl.size / DECK);
  at(all('.op-deck')[0], [[300, { opacity: 0, transform: move(0, 0, 0.94) }, EASE.out], [460, { opacity: 1, transform: move(0, 0) }], [950, { opacity: 1, transform: move(0, 0) }, EASE.inout],
    [1250, { opacity: 1, transform: home }], [1300, { opacity: 0, transform: home }]]);
  at(all('.op-arm')[0], [[420, { transform: 'rotate(0deg)' }, EASE.inout], [680, { transform: 'rotate(27deg)' }]]);
  at(all('.op-disc')[0], [[600, { transform: 'rotate(0deg)' }, GRAVITY], [900, { transform: 'rotate(110deg)' }], [1300, { transform: 'rotate(400deg)' }]]);
  // The cards fall from the lamp along its light and land as warm bars beside the record, then glide into the header.
  const gap = g.n > 1 ? Math.min(45, 240 / (g.n - 1)) : 0;
  const wraps = all('.op-bw');
  g.bars.forEach((bar, i) => {
    const t0 = 380 + i * gap;
    const t1 = t0 + 320;
    const g0 = 980 + i * 10;
    const g1 = g0 + 280;
    at(wraps[i], [[t0, { transform: sway(-10, bar.from.x - bar.x, bar.from.y - bar.base) }, FALL], [t0 + 170, { transform: sway(-4, bar.mid.x - bar.x, bar.mid.y - bar.base) }, EASE.out],
      [t1, { transform: sway(0, 0, 0) }], [g0, { transform: sway(0, 0, 0) }, EASE.inout], [g1, { transform: sway(0, bar.to.x - bar.x, bar.to.y - bar.base, 0.42) }]]);
    const card = { width: px(cw), height: px(ch), borderRadius: px(cr), backgroundColor: g.colors.card };
    const stick = { width: px(bw), height: px(bar.h), borderRadius: px(bw / 2), backgroundColor: bar.peak ? g.colors.peak : g.colors.bar };
    at(wraps[i]?.firstElementChild, [[t0, { opacity: 0, ...card }], [t0 + 60, { opacity: 1, ...card }], [t0 + 220, { opacity: 1, ...card }, EASE.out], [t1, { opacity: 1, ...stick }],
      [g0 + 180, { opacity: 1, ...stick }], [g1, { opacity: 0, ...stick }]]);
  });
  // The page under it fades up in the lamp light: the sidebar, its keys one by one, the logo, the record, the content.
  at(p.sidebar, [[900, { opacity: 0 }, EASE.inout], [1150, { opacity: 1 }]], false);
  p.keys.forEach((key, i) => {
    const t = 930 + i * 38;
    at(key, [[t, { opacity: 0, filter: 'brightness(1)' }, EASE.out], [t + 120, { opacity: 1, filter: 'brightness(1.45)' }, EASE.inout], [t + 300, { opacity: 1, filter: 'brightness(1)' }]], false);
  });
  at(p.brand, [[1150, { opacity: 0 }, EASE.inout], [1300, { opacity: 1 }]], false);
  at(p.vinyl, [[1245, { opacity: 0 }], [1290, { opacity: 1 }]], false);
  at(p.header, [[1200, { opacity: 0 }, EASE.inout], [1450, { opacity: 1 }]], false);
  const block = j => {
    const t = 1220 + Math.min(j, 5) * 25;
    return [[t, { opacity: 0 }, EASE.inout], [t + 200, { opacity: 1 }]];
  };
  p.blocks.forEach((el, j) => at(el, block(j), false));
  return block;
}

// ready: the first data has arrived (it says how many jobs are new); failed: it could not arrive.
export function Opening({ ready, failed, newJobs = 0 }) {
  const [on, setOn] = useState(playing);
  const [stage, setStage] = useState(null);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const cover = useRef(null);
  const parts = useRef(null);
  const anims = useRef([]);
  const watch = useRef(null);
  const started = useRef(false);

  // Ends it, at once if it is still going: everything jumps to where it lands and the cover goes.
  const close = useCallback(() => {
    if (!playing) return;
    playing = false;
    watch.current?.disconnect();
    const running = anims.current;
    anims.current = [];
    running.forEach(anim => { try { anim.finish(); } catch { anim.cancel(); } });
    setOn(false);
  }, []);

  useEffect(() => {
    if (!on) return undefined;
    const seen = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', seen);
    // A key skips it too (it covers the page, so nothing under it is waiting for the key).
    const key = event => { if (!event.repeat) close(); };
    window.addEventListener('keydown', key, true);
    // Not shown or no data in time (a window started hidden, or a slow start): the page goes on without it. A timer,
    // not an animation, since a hidden window draws no frames.
    const wait = setTimeout(() => { if (!started.current) close(); }, WAIT);
    return () => {
      document.removeEventListener('visibilitychange', seen);
      window.removeEventListener('keydown', key, true);
      clearTimeout(wait);
    };
  }, [on, close]);

  useEffect(() => {
    if (!on) return undefined;
    if (failed) { close(); return undefined; }
    if (!ready || !visible) return undefined;
    // On the next frame the page under it has been laid out, so the landing places can be measured.
    const frame = requestAnimationFrame(() => {
      if (started.current) return;
      started.current = true;
      const night = document.documentElement.dataset.theme === 'night';
      const measured = measure(night, newJobs);
      parts.current = measured.parts;
      setStage(measured.scene);
    });
    return () => cancelAnimationFrame(frame);
  }, [on, ready, visible, failed, newJobs, close]);

  useLayoutEffect(() => {
    if (!stage || !cover.current) return;
    const style = getComputedStyle(cover.current);
    const scene = { ...stage, colors: { card: style.getPropertyValue('--op-card').trim(), bar: style.getPropertyValue('--op-bar').trim(), peak: style.getPropertyValue('--op-peak').trim() } };
    const all = selector => [...cover.current.querySelectorAll(selector)];
    // The cover's own pieces keep their last frame until it goes; the page's parts only borrow theirs.
    const play = (el, points, total, own = true) => {
      if (!el?.animate) return null;
      const anim = el.animate(keyframes(points, total), { duration: total, fill: own ? 'both' : 'backwards' });
      anims.current.push(anim);
      return anim;
    };
    const block = (stage.night ? playNight : playDay)({ scene, parts: parts.current, all, play });
    // The ground is the clock: when its animation ends, so does the opening. Its promise, not its finish event, which
    // only comes with a frame that a hidden window never draws.
    const clock = anims.current[0];
    if (clock) clock.finished.then(close, () => {});
    else { close(); return undefined; }
    // A page that loads its own data (Home) puts its content in while the opening plays: each new block joins in at
    // the moment the opening has reached, so it still fades up in its turn instead of showing through early.
    const { section, header } = parts.current;
    if (!section) return undefined;
    const joined = new WeakSet(parts.current.blocks);
    watch.current = new MutationObserver(() => {
      [...section.children].filter(child => child !== header).forEach((el, j) => {
        if (joined.has(el)) return;
        joined.add(el);
        const anim = play(el, block(j), stage.night ? LENGTH.night : LENGTH.day, false);
        if (anim) anim.currentTime = clock.currentTime;
      });
    });
    watch.current.observe(section, { childList: true });
    return () => watch.current?.disconnect();
  }, [stage, close]);

  if (!on) return null;
  const night = stage ? stage.night : typeof document !== 'undefined' && document.documentElement.dataset.theme === 'night';
  return (
    <div ref={cover} className={`opening ${night ? 'night' : 'day'}`} onClick={close} aria-hidden="true">
      <i className="op-ground" />
      {stage && !stage.night ? <DayScene scene={stage} /> : null}
      {stage && stage.night ? <NightScene scene={stage} /> : null}
    </div>
  );
}

function Cards({ bars }) {
  return bars.map((bar, i) => <span key={i} className="op-bw" style={{ left: bar.x, top: bar.base }}><span className="op-card"><i /><i /><b /></span></span>);
}

function DayScene({ scene }) {
  const { hero } = scene;
  return (
    <>
      <i className="op-sun" style={{ left: hero.x - 180, top: hero.y - 180 }} />
      <Cards bars={scene.bars} />
      <span className="op-hero" style={{ left: hero.x - HERO / 2, top: hero.y - HERO / 2 }}><MarkGlyph /></span>
    </>
  );
}

function NightScene({ scene }) {
  const { lamp, deck, spread, H } = scene;
  return (
    <>
      <i className="op-glow" />
      <i className="op-cone" style={{ left: lamp.x - spread, top: lamp.mouth, width: spread * 2, height: H - lamp.mouth,
        clipPath: `polygon(${spread - 20}px 0, ${spread + 20}px 0, 100% 100%, 0 100%)` }} />
      <i className="op-pool" style={{ left: deck.x - 280, top: deck.y + 10, width: 560, height: 150 }} />
      <span className="op-lamp" style={{ left: lamp.x - 32 }}>
        <svg viewBox="0 0 46 44"><path d="M23 0V15" className="lamp-cord" /><path d="M9 34L15 14H31L37 34Z" className="lamp-shade" /><ellipse cx="23" cy="35" rx="9" ry="3.5" className="lamp-bulb" /></svg>
      </span>
      <span className="op-deck" style={{ left: deck.x - DECK / 2, top: deck.y - DECK / 2 }}>
        <span className="op-disc"><i /></span>
        <span className="op-arm"><b /></span>
        <span className="op-pivot" />
      </span>
      <Cards bars={scene.bars} />
    </>
  );
}
