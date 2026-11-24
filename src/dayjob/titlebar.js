// 窗口边框: the desktop window has no title bar of its own (desktop/main.cjs). The page keeps a strip at its top in
// the sidebar's colour (frame.css) and the system draws the three window buttons over the strip's right end. This
// tells the window what colours to draw them in, so they sit on the strip as if they were part of the page: at the
// start, and again whenever day turns to night or back. While the opening covers the window the buttons take its
// ground instead.
const desktop = typeof window !== 'undefined' ? window.dayjobDesktop : undefined;
// How tall the strip is; 0 in a web browser and where the system's own title bar stays.
export const TITLE_BAR = Number(desktop?.titleBar) > 0 && typeof desktop.setTitleBar === 'function' ? Number(desktop.titleBar) : 0;

// '#abc' or '#aabbcc' as '#aabbcc'; anything else is no colour.
export function hexColor(value) {
  const found = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!found) return null;
  const digits = found[1].length === 3 ? [...found[1]].map(digit => digit + digit).join('') : found[1];
  return `#${digits.toUpperCase()}`;
}

// A shade such as 'rgb(30 43 56 / 46%)' as { rgb: [30, 43, 56], alpha: 0.46 }; anything else is no shade.
export function shadeOf(value) {
  const parts = String(value || '').match(/[\d.]+%?/g);
  if (!parts || parts.length < 4) return null;
  const rgb = parts.slice(0, 3).map(Number);
  const alpha = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3]);
  return rgb.every(part => part >= 0 && part <= 255) && alpha > 0 && alpha <= 1 ? { rgb, alpha } : null;
}
// A colour ('#aabbcc') as it looks under a shade.
export function shaded(color, shade) {
  if (!shade) return color;
  const mixed = [1, 3, 5].map((at, part) => Math.round(parseInt(color.slice(at, at + 2), 16) * (1 - shade.alpha) + shade.rgb[part] * shade.alpha));
  return `#${mixed.map(part => part.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

let covered = false;
let last = '';
export function paintTitleBar() {
  if (!TITLE_BAR) return;
  const style = getComputedStyle(document.documentElement);
  // The guide lays a shade over the whole window, the strip too: the buttons are drawn as the strip looks under it.
  const veil = document.querySelector('.guide:not(.leaving)');
  const shade = veil && !covered ? shadeOf(getComputedStyle(veil).getPropertyValue('--guide-shade')) : null;
  const ground = hexColor(style.getPropertyValue(covered ? '--surface' : '--side'));
  const ink = hexColor(style.getPropertyValue(covered ? '--text' : '--side-text'));
  // The styles are not there yet: the next call paints.
  if (!ground || !ink) return;
  const color = shaded(ground, shade);
  const symbolColor = shaded(ink, shade);
  const key = `${color} ${symbolColor}`;
  if (key === last) return;
  last = key;
  desktop.setTitleBar({ color, symbolColor }).catch(() => { last = ''; });
}

// The opening is over the window (true) or has given way to the page (false).
export function coverTitleBar(on) {
  covered = Boolean(on);
  paintTitleBar();
}

// The theme sweeps over the page: night falls from the top, so the strip turns at once; day rises from the bottom,
// so the strip is the last to turn and the buttons wait for it (theme.js gives the sweep's length).
let waiting = 0;
function themeTurned() {
  const root = document.documentElement;
  clearTimeout(waiting);
  const sweep = root.classList.contains('to-day') ? parseFloat(root.style.getPropertyValue('--theme-sweep')) || 0 : 0;
  if (sweep) waiting = setTimeout(paintTitleBar, sweep * 0.85);
  else paintTitleBar();
}

if (TITLE_BAR) {
  // The strip's height, for frame.css. Set here, in the page's own script, and not in public/theme-init.js: that
  // file is kept by the window for an hour, so just after an update an old copy of it would still be the one run.
  document.documentElement.style.setProperty('--titlebar', `${TITLE_BAR}px`);
  document.documentElement.classList.add('framed');
  new MutationObserver(themeTurned).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('load', paintTitleBar);
  paintTitleBar();
}
