import { BEAT, cue, reducedMotion } from './sound.js';

// Click motion (see the 点击动效 board): every move is done within a beat, only follows a click or its result,
// and is skipped when the system asks for reduced motion. Elements opt in with data-fx="name" (several names may be
// listed); the work that depends on a result (saved, deleted, failed) calls the helpers below directly.
export const E8 = BEAT / 8;
export const Q = BEAT / 4;
export const EASE = { out: 'cubic-bezier(.2, .8, .2, 1)', spring: 'cubic-bezier(.2, .9, .3, 1.4)', snap: 'cubic-bezier(.3, 0, 0, 1)', inout: 'cubic-bezier(.45, 0, .55, 1)', in: 'cubic-bezier(.6, 0, .8, .2)' };

export function animate(el, frames, options = {}) {
  if (!el?.animate || reducedMotion()) return null;
  return el.animate(frames, { duration: Q, easing: EASE.out, ...options });
}
const iconOf = el => el?.querySelector?.('svg') || el;
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const centre = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, r }; };

export const press = el => animate(el, [{ transform: 'none' }, { transform: 'translateY(2px)', offset: 0.3 }, { transform: 'none' }], { duration: Q + E8, easing: EASE.snap });
// Pressed like a key, then the page goes where it leads, once the key is down.
export const pressThen = (el, go) => { press(el); setTimeout(go, reducedMotion() ? 0 : Q); };
export const pop = (el, scale = 1.18) => animate(el, [{ transform: 'scale(1)' }, { transform: `scale(${scale})`, offset: 0.4 }, { transform: 'scale(1)' }], { duration: Q * 1.5, easing: EASE.spring });
export const spin = (el, turns = 1, duration = BEAT) => animate(iconOf(el), [{ transform: 'rotate(0deg)' }, { transform: `rotate(${360 * turns}deg)` }], { duration, easing: EASE.inout });
export const wiggle = (el, deg = 14) => animate(iconOf(el), [0, -deg, deg, -deg / 2, deg / 3, 0].map(d => ({ transform: `rotate(${d}deg)` })), { duration: BEAT * 0.75, easing: EASE.inout });
export const shake = el => animate(el, [0, -4, 4, -3, 3, 0].map(x => ({ transform: `translateX(${x}px)` })), { duration: BEAT * 0.6, easing: 'linear' });
export const blink = el => animate(iconOf(el), [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.1)', offset: 0.45 }, { transform: 'scaleY(1)' }], { duration: Q * 1.5, easing: EASE.inout });
export const fadeIn = (el, delay = 0) => animate(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: Q * 1.5, delay, fill: 'backwards' });
// An arrow or icon points the way it goes, then comes back.
export const point = (el, x, y) => animate(iconOf(el), [{ transform: 'none' }, { transform: `translate(${x}px, ${y}px)`, offset: 0.4 }, { transform: 'none' }], { duration: Q * 1.5, easing: EASE.spring });

// A new value rolls in from below like a desk calendar's page (dates).
export const flipIn = el => animate(el, [{ transform: 'perspective(240px) rotateX(-60deg)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: Q * 1.5, easing: EASE.spring });
// A bar or tile rises a little and settles (a funnel step, a week's bar).
export const rise = el => animate(el, [{ transform: 'none' }, { transform: 'translateY(-5px)', offset: 0.35 }, { transform: 'none' }], { duration: Q * 2, easing: EASE.spring });
// A pen stroke sweeps under a field from the left (a note written down).
export function underline(el) {
  if (!el || reducedMotion()) return;
  el.classList.remove('fx-underline');
  void el.offsetWidth;
  el.classList.add('fx-underline');
  el.addEventListener('animationend', () => el.classList.remove('fx-underline'), { once: true });
}

// Plays an element's way out, then calls done (at once when motion is reduced). Returns the animation, so a
// caller whose request fails can cancel it and put the element back.
const EXITS = {
  fold: h => [{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0, marginBottom: 0 }],
  shrink: () => [{ transform: 'none', opacity: 1 }, { transform: 'scale(.92)', opacity: 0 }],
  slide: h => [{ transform: 'none', opacity: 1, height: `${h}px` }, { transform: 'translateX(-24px)', opacity: 0, height: `${h}px`, offset: 0.45 }, { transform: 'translateX(-24px)', opacity: 0, height: '0px', paddingTop: 0, paddingBottom: 0 }],
  aside: h => [{ transform: 'none', opacity: 1, height: `${h}px` }, { transform: 'translateX(28px)', opacity: 0.4, height: `${h}px`, offset: 0.4 }, { transform: 'translateX(28px)', opacity: 0, height: '0px' }],
  up: h => [{ transform: 'none', opacity: 1, height: `${h}px` }, { transform: 'translateY(-10px)', opacity: 0, height: '0px', paddingTop: 0, paddingBottom: 0, marginTop: 0, marginBottom: 0 }],
  right: () => [{ transform: 'none', opacity: 1 }, { transform: 'translateX(40px)', opacity: 0 }],
  left: () => [{ transform: 'none', opacity: 1 }, { transform: 'translateX(-24px)', opacity: 0 }],
  // Narrows to nothing so its neighbours close the gap (a browser tab).
  narrow: (h, el) => [{ width: `${el.offsetWidth}px`, minWidth: '0px', opacity: 1 }, { width: '0px', minWidth: '0px', opacity: 0, transform: 'scale(.85)' }],
};
export function leave(el, kind = 'fold', done) {
  if (!el?.animate || reducedMotion()) { done?.(); return null; }
  const anim = el.animate(EXITS[kind](el.offsetHeight, el), { duration: ['shrink', 'right', 'left', 'narrow'].includes(kind) ? Q * 1.25 : BEAT * 0.75, easing: EASE.in, fill: 'forwards' });
  el.style.overflow = 'hidden';
  anim.onfinish = () => done?.();
  return anim;
}
// The way out first, then the request; if the request fails (returns false) the element comes back.
export function leaveThen(el, kind, work) {
  let anim = null;
  anim = leave(el, kind, async () => { if ((await work()) === false) anim?.cancel(); });
  return anim;
}
// The reverse: an element that just appeared grows out of its gap.
export function unfold(el, delay = 0) {
  if (!el?.animate || reducedMotion()) return null;
  const h = el.offsetHeight;
  return el.animate([{ height: '0px', opacity: 0, overflow: 'hidden' }, { height: `${h}px`, opacity: 1, overflow: 'hidden' }], { duration: BEAT * 0.6, delay, easing: EASE.out, fill: 'backwards' });
}

// A note (or a page) flies from the clicked button into a sidebar key, which then presses and bumps its count.
const GLYPHS = {
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="17" cy="16" r="3" fill="currentColor"/></svg>',
  page: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="3" fill="var(--card)" stroke="currentColor" stroke-width="1.8"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
export function keyBump(view) {
  const key = document.querySelector(`.pkey[data-view="${view}"]`);
  if (!key) return;
  animate(key, [{ filter: 'brightness(1)' }, { filter: 'brightness(.9)', offset: 0.25 }, { filter: 'brightness(1)' }], { duration: Q * 1.5, easing: EASE.snap });
  // The count updates a moment later, when the status comes back; bump it when it does.
  setTimeout(() => pop(key.querySelector('em'), 1.3), Q);
}
// The target is a sidebar page (by its view name) or any element on the page.
export function flyTo(from, target, glyph = 'note') {
  const view = typeof target === 'string' ? target : null;
  const key = view ? document.querySelector(`.pkey[data-view="${view}"]`) : target;
  const land = () => (view ? keyBump(view) : pop(key, 1.04));
  if (!from || !key || reducedMotion()) { if (key) land(); return; }
  const a = centre(from);
  const b = centre(key);
  const el = document.createElement('span');
  el.className = `fx-fly ${glyph}`;
  el.innerHTML = GLYPHS[glyph];
  el.style.left = `${a.x - 11}px`;
  el.style.top = `${a.y - 11}px`;
  document.body.appendChild(el);
  const dx = (view ? b.r.left + 34 : b.x) - a.x;
  const dy = b.y - a.y;
  const anim = el.animate([
    { transform: 'translate(0, 0) scale(.5)', opacity: 0 },
    { transform: `translate(${dx * 0.3}px, ${dy * 0.3 - 70}px) scale(1.1)`, opacity: 1, offset: 0.35 },
    { transform: `translate(${dx}px, ${dy}px) scale(.6)`, opacity: 0.9 },
  ], { duration: BEAT, easing: EASE.inout });
  anim.onfinish = () => { el.remove(); land(); };
}

// Rings spread behind an element (yellow only for good news).
export function rings(el, { count = 1, tone = 'blue', scale = 5 } = {}) {
  if (!el || reducedMotion()) return;
  const host = el.closest('.fx-ring-host') || el;
  host.classList.add('fx-ring-host');
  for (let i = 0; i < count; i += 1) {
    const ring = document.createElement('i');
    ring.className = `fx-ring ${tone}`;
    host.appendChild(ring);
    const anim = ring.animate([{ opacity: 0.6, transform: 'translate(-50%, -50%) scale(.3)' }, { opacity: 0, transform: `translate(-50%, -50%) scale(${scale})` }], { duration: BEAT * 1.2, delay: i * E8, easing: EASE.out, fill: 'backwards' });
    anim.onfinish = () => ring.remove();
  }
}
// A handful of notes thrown out of an element, once (the offer).
export function burst(el, count = 9) {
  if (!el || reducedMotion()) return;
  const a = centre(el);
  const colours = [token('--step-hi'), token('--step-mid'), token('--green')];
  for (let i = 0; i < count; i += 1) {
    const note = document.createElement('span');
    note.className = 'fx-fly note';
    note.innerHTML = GLYPHS.note;
    note.style.color = colours[i % colours.length];
    note.style.left = `${a.x - 11}px`;
    note.style.top = `${a.r.top + 30}px`;
    document.body.appendChild(note);
    const angle = (-160 + (140 / (count - 1)) * i) * (Math.PI / 180);
    const far = 70 + (i % 3) * 26;
    const anim = note.animate([
      { transform: 'translate(0, 0) scale(.4)', opacity: 0 },
      { transform: `translate(${Math.cos(angle) * far * 0.7}px, ${Math.sin(angle) * far * 0.7}px) scale(1)`, opacity: 1, offset: 0.4 },
      { transform: `translate(${Math.cos(angle) * far}px, ${Math.sin(angle) * far + 30}px) rotate(${i % 2 ? 20 : -20}deg) scale(.8)`, opacity: 0 },
    ], { duration: BEAT * 1.6, delay: (i % 4) * (E8 / 2), easing: EASE.out, fill: 'backwards' });
    anim.onfinish = () => note.remove();
  }
}
// A small note floats up out of a button (a goal step done) or drops down from it (taken back).
export function floatNote(el, up = true) {
  if (!el || reducedMotion()) return;
  const a = centre(el);
  const note = document.createElement('span');
  note.className = 'fx-fly note';
  note.innerHTML = GLYPHS.note;
  note.style.left = `${a.x - 8}px`;
  note.style.top = `${a.y - 8}px`;
  note.style.width = note.style.height = '16px';
  if (!up) note.style.color = 'var(--line-strong)';
  document.body.appendChild(note);
  const anim = note.animate([{ transform: 'translateY(0)', opacity: 0 }, { transform: `translateY(${up ? -10 : 6}px)`, opacity: 1, offset: 0.3 }, { transform: `translateY(${up ? -34 : 22}px) rotate(${up ? -12 : 12}deg)`, opacity: 0 }],
    { duration: BEAT, easing: EASE.out });
  anim.onfinish = () => note.remove();
}
// A few small dots scatter out of an element and fade (a saved key removed).
export function scatter(el, count = 7) {
  if (!el || reducedMotion()) return;
  const a = centre(el);
  for (let i = 0; i < count; i += 1) {
    const dot = document.createElement('i');
    dot.className = 'fx-dot';
    dot.style.left = `${a.r.right - 26}px`;
    dot.style.top = `${a.y - 3}px`;
    document.body.appendChild(dot);
    const angle = (i / count) * Math.PI * 2;
    const far = 16 + (i % 3) * 8;
    const anim = dot.animate([{ transform: 'translate(0, 0) scale(1)', opacity: 0.9 }, { transform: `translate(${Math.cos(angle) * far}px, ${Math.sin(angle) * far}px) scale(.4)`, opacity: 0 }],
      { duration: BEAT * 0.75, easing: EASE.out });
    anim.onfinish = () => dot.remove();
  }
}
// A wave of light sweeps across a card from left to right, getting stronger (a goal reached).
export function sweep(el) {
  if (!el || reducedMotion()) return;
  el.classList.add('fx-ring-host');
  const band = document.createElement('span');
  band.className = 'fx-sweep';
  el.appendChild(band);
  const anim = band.animate([{ transform: 'translateX(-100%)', opacity: 0.2 }, { transform: 'translateX(0%)', opacity: 0.9, offset: 0.6 }, { transform: 'translateX(100%)', opacity: 0 }], { duration: BEAT * 1.6, easing: EASE.inout });
  anim.onfinish = () => band.remove();
}
// Each element in turn lights up as if typed into, a cursor jumping from box to box (autofill, read from resume).
export function typeIn(elements) {
  [...elements].forEach((el, i) => animate(el, [{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 3px var(--focus), inset 3px 0 0 var(--green)', offset: 0.3 }, { boxShadow: '0 0 0 0 transparent' }],
    { duration: BEAT * 0.75, delay: i * E8, easing: EASE.out }));
  if (elements.length) cue('type');
}

// A stamp lands in the corner of a card and stays for a moment (accepted).
export function stamp(el, text) {
  if (!el || reducedMotion()) return;
  el.classList.add('fx-ring-host');
  const mark = document.createElement('span');
  mark.className = 'fx-stamp';
  mark.textContent = text;
  el.appendChild(mark);
  const anim = mark.animate([
    { transform: 'rotate(-14deg) scale(1.8)', opacity: 0 },
    { transform: 'rotate(-14deg) scale(.94)', opacity: 1, offset: 0.25 },
    { transform: 'rotate(-14deg) scale(1)', opacity: 1, offset: 0.35 },
    { transform: 'rotate(-14deg) scale(1)', opacity: 1, offset: 0.85 },
    { transform: 'rotate(-14deg) scale(1)', opacity: 0 },
  ], { duration: BEAT * 4, easing: EASE.out });
  anim.onfinish = () => mark.remove();
}
// A brief state on a card: lit up (interview), greyed (rejected), dashed and fading (ghosted).
export function tint(el, kind) {
  if (!el) return;
  const frames = {
    lit: [{ boxShadow: 'inset 0 -5px 0 var(--key-lip), 0 0 0 0 rgb(249 215 126 / 0%)' }, { boxShadow: `inset 0 -5px 0 var(--key-lip), 0 0 0 6px ${token('--good')}66`, offset: 0.4 }, { boxShadow: 'inset 0 -5px 0 var(--key-lip), 0 0 0 0 rgb(249 215 126 / 0%)' }],
    grey: [{ filter: 'grayscale(0)', opacity: 1 }, { filter: 'grayscale(1)', opacity: 0.6, offset: 0.6 }, { filter: 'grayscale(0)', opacity: 1 }],
    ghost: [{ outline: '2px dashed transparent', opacity: 1 }, { outline: `2px dashed ${token('--line-strong')}`, opacity: 0.5, offset: 0.6 }, { outline: '2px dashed transparent', opacity: 1 }],
  }[kind];
  animate(el, frames, { duration: BEAT * (kind === 'lit' ? 1.2 : 2), easing: EASE.inout });
}

// The selected marker of a group slides from the old choice to the new one, like a knob turning a notch,
// instead of one switching off and the other on. Works for segmented controls, tabs, status chips and choice cards.
const gliding = new WeakSet();
export function glide(group, selector, { line = false } = {}) {
  if (!group || gliding.has(group) || reducedMotion()) return;
  const from = group.querySelector(selector);
  if (!from) return;
  gliding.add(group);
  const a = from.getBoundingClientRect();
  const style = getComputedStyle(from);
  // The new choice may only be marked once a request returns (a status), so wait up to about half a second for it.
  let frames = 0;
  const wait = () => {
    const to = group.querySelector(selector);
    if ((!to || to === from) && frames < 30) { frames += 1; requestAnimationFrame(wait); return; }
    gliding.delete(group);
    if (!to || to === from) return;
    const b = to.getBoundingClientRect();
    const g = group.getBoundingClientRect();
    if (Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1) return;
    group.classList.add('fx-glide-host');
    const ghost = document.createElement('span');
    ghost.className = 'fx-glide';
    const border = parseFloat(style.borderTopWidth) > 0 ? `inset 0 0 0 ${style.borderTopWidth} ${style.borderTopColor}` : 'none';
    Object.assign(ghost.style, line
      ? { left: `${b.left - g.left}px`, top: `${b.bottom - g.top - 2}px`, width: `${b.width}px`, height: '2px', background: style.borderBottomColor }
      : { left: `${b.left - g.left}px`, top: `${b.top - g.top}px`, width: `${b.width}px`, height: `${b.height}px`, background: style.backgroundColor, borderRadius: style.borderRadius, boxShadow: border });
    group.appendChild(ghost);
    const keep = line ? 'borderBottomColor' : 'backgroundColor';
    to.style[keep] = 'transparent';
    if (!line) {
      // Until the marker arrives the new choice keeps the plain text colour, so white-on-colour text never sits on nothing.
      to.style.borderColor = 'transparent';
      const idle = [...group.children].find(child => child !== to && child.tagName === to.tagName && !child.matches(selector));
      if (idle) to.style.color = getComputedStyle(idle).color;
    }
    const anim = ghost.animate([
      { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)`, width: `${a.width}px` },
      { transform: 'translate(0, 0)', width: `${b.width}px` },
    ], { duration: Q * 1.5, easing: EASE.snap });
    anim.onfinish = () => { to.style[keep] = ''; to.style.borderColor = ''; to.style.color = ''; ghost.remove(); };
  };
  requestAnimationFrame(wait);
}

// A list re-sorted or filtered: rows that stay slide to their new place, new rows grow out of the gap.
// Call measure() before the change and play() after it renders (from a layout effect).
export function flipList(list) {
  const rows = () => [...(list?.children || [])].filter(row => row.dataset.id);
  let before = null;
  return {
    measure() { before = new Map(rows().map(row => [row.dataset.id, row.offsetTop])); },
    play() {
      if (!before || reducedMotion()) { before = null; return; }
      let fresh = 0;
      rows().forEach(row => {
        const was = before.get(row.dataset.id);
        if (was === undefined) { unfold(row, Math.min(fresh, 8) * E8); fresh += 1; return; }
        const dy = was - row.offsetTop;
        if (Math.abs(dy) > 1) row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: BEAT * 0.6, easing: EASE.snap });
      });
      before = null;
    },
  };
}

// Hold to confirm (auto-submit): the ring fills in 0.6 s; letting go early cancels.
export function holdToConfirm(el, onConfirm, ms = 600) {
  if (!el) return () => {};
  el.style.setProperty('--hold', '0');
  el.classList.add('holding');
  const start = performance.now();
  let frame = 0;
  const tick = now => {
    const share = Math.min(1, (now - start) / ms);
    el.style.setProperty('--hold', String(share));
    if (share >= 1) { el.classList.remove('holding'); el.style.removeProperty('--hold'); pop(el, 1.06); onConfirm(); return; }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(frame); el.classList.remove('holding'); el.style.removeProperty('--hold'); };
}

// What a click does at once, by data-fx name. Sounds play here too, so a click is heard even before its request returns.
const ON_CLICK = {
  refresh: el => spin(el),
  rescore: el => spin(el),
  rewind: el => spin(el, -0.5, Q * 2),
  undo: el => { spin(el, -0.5, Q * 2); cue('undo'); },
  open: el => { animate(iconOf(el), [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], { duration: Q * 2, easing: EASE.inout }); cue('open'); },
  external: el => point(el, 3, -3),
  select: el => press(el),
  sparkle: el => pop(iconOf(el), 1.35),
  wiggle: el => wiggle(el),
  bell: el => wiggle(el, 18),
  folder: el => animate(iconOf(el), [{ transform: 'none' }, { transform: 'translateY(-2px) rotate(-8deg)', offset: 0.4 }, { transform: 'none' }], { duration: Q * 2, easing: EASE.spring }),
  sweep: el => animate(iconOf(el), [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-28deg)', offset: 0.3 }, { transform: 'rotate(18deg)', offset: 0.7 }, { transform: 'rotate(0deg)' }], { duration: BEAT * 0.75, easing: EASE.inout }),
  back: el => point(el, -4, 0),
  forward: el => point(el, 4, 0),
  stop: el => animate(iconOf(el), [{ transform: 'scale(1)' }, { transform: 'scale(.4)', offset: 0.5 }, { transform: 'scale(1)' }], { duration: Q * 1.5, easing: EASE.snap }),
  flip: el => animate(el, [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(90deg)', offset: 0.5 }, { transform: 'rotateX(0deg)' }], { duration: Q * 2, easing: EASE.inout }),
  pop: el => pop(iconOf(el)),
  press: el => press(el),
  pick: () => cue('pick'),
  dismiss: el => { blink(el); cue('dismiss'); },
  knock: () => cue('knock'),
  hourglass: el => animate(iconOf(el), [{ transform: 'rotate(0deg)' }, { transform: 'rotate(180deg)' }], { duration: Q * 2, easing: EASE.spring }),
  calendar: el => animate(iconOf(el), [{ transform: 'none' }, { transform: 'perspective(60px) rotateX(-40deg)', offset: 0.4 }, { transform: 'none' }], { duration: Q * 2, easing: EASE.spring }),
  // Light: the sun comes up over the horizon. Dark: the desk lamp lights up. System: the screen blinks on.
  sunrise: el => animate(iconOf(el), [{ transform: 'translateY(7px)', opacity: 0.2 }, { transform: 'none', opacity: 1 }], { duration: Q * 2, easing: EASE.spring }),
  lamp: el => animate(iconOf(el), [{ filter: 'drop-shadow(0 0 0 transparent)', transform: 'none' }, { filter: `drop-shadow(0 3px 4px ${token('--step-hi')})`, transform: 'rotate(-10deg)', offset: 0.4 }, { filter: 'drop-shadow(0 0 0 transparent)', transform: 'none' }], { duration: BEAT, easing: EASE.out }),
  screen: el => animate(iconOf(el), [{ opacity: 0.2 }, { opacity: 1, offset: 0.3 }, { opacity: 0.6, offset: 0.45 }, { opacity: 1 }], { duration: Q * 2, easing: 'linear' }),
  morph: el => animate(iconOf(el), [{ transform: 'rotate(-90deg) scale(.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: Q * 1.5, easing: EASE.spring }),
  // The language changes in the same beat: the page fades through instead of jumping.
  lang: () => animate(document.querySelector('.app-shell'), [{ opacity: 0.55 }, { opacity: 1 }], { duration: Q * 2, easing: EASE.out }),
};
function onClick(event) {
  const el = event.target.closest?.('[data-fx]');
  if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') el.dataset.fx.split(' ').forEach(name => ON_CLICK[name]?.(el, event));
  // A close button's ✕ turns a quarter and shrinks, whatever it closes.
  const button = event.target.closest?.('button');
  const x = button && !button.disabled && button.querySelector(':scope > svg.lucide-x');
  if (x) animate(x, [{ transform: 'rotate(0deg) scale(1)' }, { transform: 'rotate(90deg) scale(.7)' }], { duration: Q, easing: EASE.snap });
  // Groups with one selected choice glide to the new one.
  const choice = event.target.closest?.('.segmented > button, .tabs > button, .status-buttons > button, .choice-row > label');
  if (choice && !choice.disabled && !choice.matches('.active, .selected')) {
    const group = choice.parentElement;
    if (group.classList.contains('tabs')) glide(group, '.active', { line: true });
    else glide(group, group.classList.contains('choice-row') ? '.selected' : '.active');
    if (!group.classList.contains('status-buttons')) cue('knob');
  }
}
// Something that failed answers with one dull note; its message shakes in by itself (fx.css).
function watchErrors() {
  if (typeof MutationObserver === 'undefined') return () => {};
  const seen = new WeakSet();
  const observer = new MutationObserver(records => {
    const added = records.flatMap(record => [...record.addedNodes]).filter(node => node.nodeType === 1);
    if (added.some(node => (node.matches('.notice.error') || node.querySelector('.notice.error')) && !seen.has(node) && seen.add(node))) cue('error');
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
export function installClickFx() {
  document.addEventListener('click', onClick, true);
  const stop = watchErrors();
  return () => { document.removeEventListener('click', onClick, true); stop(); };
}
