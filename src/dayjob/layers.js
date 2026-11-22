// The browser and the assistant open as layers at the right of the window, over the page: the sidebar and the page
// stay as they are, with the width and the layout they have when nothing is open (dayjob.css, "layers at the right").
// This works out where the layers stand in a window of a given width.
export const SIDEBAR = 216;
export const PANE_MIN = 420;
export const RESIZER = 6;
// The browser, dragged as wide as it goes, leaves this much of the page in sight; covering the page is its own button.
export const PAGE_EDGE = 120;
// The assistant's side chat keeps a fixed width at the right edge, and the browser stands to its left. As a full
// page it covers the page instead, up to the browser.
export const ASSISTANT_WIDTH = 360;
// Below this window width the full-page chat and the browser do not both fit: the chat goes to the side.
export const FULL_MIN_WINDOW = 1000;

// The widths the browser may have in the room it is given (the page's width, less the side chat).
export function paneLimits(room) {
  const low = Math.min(PANE_MIN, Math.max(0, room));
  return [low, Math.max(low, room - RESIZER - PAGE_EDGE)];
}

//   windowWidth              the window's inner width
//   browserOpen, browserWide the browser is open; the user asked it to cover the page
//   chatOpen, chatForm       the assistant is open, as 'side' or 'full'
//   paneWidth                the browser's width as the user dragged it, or null
// Gives back:
//   assistantFull / assistantOpen  the chat covers the page / stands at the right edge
//   beside       the width the side chat takes at the right edge (0 without it)
//   room         what is left of the page's width for the browser
//   canSide      the browser can leave some of the page in sight; when it cannot, it covers the page
//   wide         the browser covers the page (up to the side chat)
//   width        the browser's own width when it does not
//   minPane, maxPane  how narrow and how wide it can be dragged
//   pageCovered  nothing of the page is in sight
export function layersFor({ windowWidth, browserOpen = false, browserWide = false, chatOpen = false, chatForm = 'side', paneWidth = null }) {
  // When the browser covers the page (asked to, or the window too narrow for both), a full-page chat goes to the
  // side so it stays in sight.
  const assistantFull = chatForm === 'full' && !(browserOpen && (browserWide || windowWidth < FULL_MIN_WINDOW));
  const assistantOpen = Boolean(chatOpen) && !assistantFull;
  const pageWidth = Math.max(0, windowWidth - SIDEBAR);
  const beside = assistantOpen ? Math.min(ASSISTANT_WIDTH, pageWidth) : 0;
  const room = pageWidth - beside;
  const [minPane, maxPane] = paneLimits(room);
  const canSide = room >= PANE_MIN + RESIZER + PAGE_EDGE;
  const wide = browserOpen && (browserWide || !canSide);
  const width = Math.min(maxPane, Math.max(minPane, paneWidth || Math.round(room * 0.58)));
  return { assistantFull, assistantOpen, beside, room, canSide, wide, width, minPane, maxPane, pageCovered: wide || assistantFull };
}
