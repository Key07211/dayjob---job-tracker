import { useEffect, useLayoutEffect, useRef } from 'react';

// How long the next item may take to arrive before the one still on screen is dimmed.
export const SLOW_MS = 400;

// Picking another row of a list puts another item in the detail pane beside it. The pane is in the page's own
// scroller, so its height is the page's height: an item shorter than the last one makes the page shorter, the
// scroller can no longer stand where it stood, and everything on the page (the header, the filters, the list)
// jumps. Nothing may move but the pane's own content, so the pane is kept tall enough for the page to stay put.
//
// Where the page should stand once the pane shows another item, and how tall the pane has to be for that.
//   top       where the page stood just before the pane's content changed
//   height    the height of what the scroller shows at once
//   paneTop   the pane's top edge, measured from the top of what the scroller scrolls
//   below     what comes after the pane down to the end of the page
//   sticky    the list beside the pane stays in view as the page scrolls, stickyTop under the scroller's top edge
// Beside a list that stays in view, the new item starts at its top when the page was scrolled down into the last
// one: the page goes back to where the list begins to stay put, and no further, so the list does not move.
export function settle({ top, height, paneTop, below, sticky = false, stickyTop = 0 }) {
  const target = sticky ? Math.min(top, Math.max(0, paneTop - stickyTop)) : top;
  return { top: target, minHeight: Math.max(0, Math.ceil(target + height - paneTop - below)) };
}

// Puts the page right after the pane's content has changed. heldTop: where it stood just before.
export function holdPage(pane, heldTop) {
  const page = pane?.closest('.main-view');
  const row = pane?.parentElement;
  const section = page && [...page.children].find(child => child.contains(pane));
  if (!page || !row || !section) return;
  const list = row.querySelector('.posting-list');
  const look = list ? getComputedStyle(list) : null;
  const paneTop = pane.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop;
  const room = getComputedStyle(page);
  const below = (parseFloat(room.paddingBottom) || 0) + Math.max(0, section.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom);
  // A list that stays in view stays its own `top` under the scroller's padding.
  const stickyTop = (parseFloat(room.paddingTop) || 0) + (parseFloat(look?.top) || 0);
  const { top, minHeight } = settle({ top: heldTop, height: page.clientHeight, paneTop, below, sticky: look?.position === 'sticky', stickyTop });
  pane.style.minHeight = minHeight ? `${minHeight}px` : '';
  if (page.scrollTop !== top) page.scrollTop = top;
}

// For a detail whose content changes with `key`. node: a ref to anything inside the pane. Returns take(): call it
// just before the content changes (the next item has arrived and is about to be shown). Once it has changed, and
// before the screen is drawn again, the page is put right. The first item shown has nothing to hold on to.
export function usePageHold(node, key) {
  const held = useRef(null);
  const pane = useRef(null);
  useLayoutEffect(() => {
    if (held.current === null) return;
    pane.current = node.current?.closest('.detail-pane') || pane.current;
    holdPage(pane.current, held.current);
    held.current = null;
  }, [key]);
  // The height kept for the page belongs to the window's size at the time: it goes when that changes, and with the detail.
  useEffect(() => {
    const clear = () => { if (pane.current) pane.current.style.minHeight = ''; };
    window.addEventListener('resize', clear);
    return () => { window.removeEventListener('resize', clear); clear(); };
  }, []);
  return () => {
    const page = node.current?.closest('.main-view');
    held.current = page ? page.scrollTop : null;
  };
}
