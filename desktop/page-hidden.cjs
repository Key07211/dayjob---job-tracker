// Whether a page keeps an element away from the person looking at it. This runs inside web pages: the page scripts of
// browser-page.cjs, autofill.cjs and login.cjs each carry its source and call it once, so it stands alone.
//
// `inert` always does. aria-hidden="true" only says "not for screen readers", and pages use it two ways. Rightly, on
// what nobody can use just now: the page behind an open dialog, a field put there to catch robots, a second copy of
// a link, a slide waiting off to the side. And wrongly, on everything: Meta Careers marks the box that holds its
// whole application form, with no dialog open, and a person sees and fills every field in it.
//
// So a marked box is taken at its word unless it is plainly in view: drawn, a large part of the window, no dialog
// open beside it, and on top where it shows (a click on it lands in it, so nothing like a backdrop lies over it).
//
// A box to type in that the page clips to nothing is kept away too, though no mark says so: it is there to catch
// robots (Workday's "Enter website. This input is for robots only, do not enter if you're human."), and a form
// that comes back with it answered is thrown away.
function installHidden() {
  const MARK = '[aria-hidden="true"]';
  const MODAL = 'dialog[open], [aria-modal="true"]';
  // A box counts as a large part of the window from a quarter of its area.
  const LARGE = 0.25;
  // A box is judged once for all that is in it; the answer is kept this long (ms), which covers one reading of a page.
  const KEPT = 60;
  const verdicts = new WeakMap();
  const drawn = element => element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) !== false;

  // A dialog that takes the page over, open somewhere other than in the box (or around it).
  function modalBeside(box) {
    for (const dialog of box.ownerDocument.querySelectorAll(MODAL)) {
      if (box.contains(dialog) || dialog.contains(box) || !drawn(dialog)) continue;
      if (dialog.tagName === 'DIALOG' && !dialog.matches(':modal')) continue;
      const rect = dialog.getBoundingClientRect();
      if (rect.width >= 1 && rect.height >= 1) return true;
    }
    return false;
  }

  function inView(box) {
    const view = box.ownerDocument.defaultView;
    if (!view || !drawn(box)) return false;
    const width = view.innerWidth;
    const height = view.innerHeight;
    // A window with no size (a tab that was never shown) tells nothing more.
    if (width < 1 || height < 1) return true;
    const rect = box.getBoundingClientRect();
    if (rect.width * rect.height < LARGE * width * height) return false;
    // Off to the side, or above the top of the page: scrolling never brings it in.
    if (rect.right <= 0 || rect.left >= width || rect.bottom + view.scrollY <= 0) return false;
    if (modalBeside(box)) return false;
    // The part of it in the window just now. With none (it is further down the page) nothing can lie over it.
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, width);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, height);
    if (bottom <= top) return true;
    const root = box.getRootNode();
    const at = (x, y) => (typeof root.elementFromPoint === 'function' ? root : box.ownerDocument).elementFromPoint(x, y);
    let hits = 0;
    for (const across of [1 / 6, 1 / 2, 5 / 6]) {
      for (const down of [1 / 6, 1 / 2, 5 / 6]) {
        const hit = at(left + (right - left) * across, top + (bottom - top) * down);
        if (hit && (hit === box || box.contains(hit))) hits += 1;
      }
    }
    // Most of nine points: a bar along one edge may lie over it, a backdrop may not.
    return hits >= 5;
  }

  function hides(box) {
    const now = Date.now();
    const kept = verdicts.get(box);
    if (kept && now - kept.at < KEPT) return kept.hides;
    const verdict = { at: now, hides: !inView(box) };
    verdicts.set(box, verdict);
    return verdict.hides;
  }

  // A plain box to type in that nobody can see: no width or no height, or clipped to a point where it stands. (A
  // checkbox or a file field drawn that way is another matter, since its label is what people click; so is the box
  // inside a dropdown a page draws itself, which says what it is.)
  const TYPED = ['', 'text', 'email', 'url', 'tel', 'search', 'number'];
  const NOTHING = /^(inset\(\s*(50|100)%|polygon\(\s*0(px|%)? 0(px|%)?,\s*0(px|%)? 0(px|%)?,\s*0(px|%)? 0(px|%)?)/;
  function clippedAway(element) {
    const box = element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && TYPED.includes((element.getAttribute('type') || '').toLowerCase()));
    if (!box || element.readOnly || element.matches('[role], [aria-haspopup], [aria-autocomplete]') || !drawn(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return true;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return Boolean(style) && /^(absolute|fixed)$/.test(style.position) && (/^rect\(\s*[01]px/.test(style.clip) || NOTHING.test(style.clipPath));
  }

  return function hidden(element) {
    if (element.closest('[inert]')) return true;
    if (clippedAway(element)) return true;
    for (let box = element.closest(MARK); box; box = box.parentElement?.closest(MARK)) {
      if (hides(box)) return true;
    }
    return false;
  };
}

module.exports = { installHidden, HIDDEN_SOURCE: installHidden.toString() };
