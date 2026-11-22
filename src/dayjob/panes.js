// The assistant and the browser open beside the page, at the right of the window. From left to right: the sidebar,
// the page, the assistant's side chat, the browser. The browser is always the one at the window's edge, whichever
// was opened first. This works out who gets how much of a window of a given width.
export const SIDEBAR = 216;
export const PANE_MIN = 420;
export const VIEW_MIN = 360;
// The side chat keeps a fixed width; the page and the browser share what is left. As a full page the chat takes
// the page's place, with the browser still at its right.
export const ASSISTANT_WIDTH = 360;
// The page and the browser stand side by side while this much of the window is theirs (the sidebar included, the
// side chat not). Below it there is no room for the browser beside what is open: it folds into a thin bar at the
// window's edge by itself, and opened from there it takes the page's place.
export const SIDE_MIN_WINDOW = 1000;
// The folded browser's bar (dayjob.css, .browser-fold).
export const FOLD_WIDTH = 44;

// The widths the browser may be dragged to, in a window that is windowWidth wide once the side chat is taken off.
export const paneLimits = windowWidth => [PANE_MIN, Math.max(PANE_MIN, windowWidth - SIDEBAR - VIEW_MIN)];

//   windowWidth              the window's inner width
//   browserOpen, browserWide the browser is open; the user asked it to take the page's place
//   browserFolded            with no room beside what is open, the browser is the bar (true) or was opened from it
//   chatOpen, chatForm       the assistant is open, as 'side' or 'full'
//   paneWidth                the browser's width as the user dragged it, or null
// Gives back:
//   assistantFull / assistantOpen  the chat stands where the page does / is the column left of the browser
//   beside       the width the side chat takes (0 without it)
//   room         the window's width less the side chat
//   canSide      the page and the browser fit side by side
//   tight        the browser is open and there is no room for it beside the page (and the side chat)
//   folded       the browser is the thin bar at the window's edge
//   wide         the browser has the page's place
//   width        the browser's own width when it has not
//   minPane, maxPane  how narrow and how wide it can be dragged
//   pageHidden   the page is not shown: the browser or the full-page chat stands in its place
export function panesFor({ windowWidth, browserOpen = false, browserWide = false, browserFolded = false, chatOpen = false, chatForm = 'side', paneWidth = null }) {
  // Is there room for the browser beside what is open? The side chat keeps its column; the page (or the full-page
  // chat in its place) needs the rest.
  const sideChat = Boolean(chatOpen) && chatForm !== 'full';
  const tight = browserOpen && windowWidth - (sideChat ? ASSISTANT_WIDTH : 0) < SIDE_MIN_WINDOW;
  const folded = tight && Boolean(browserFolded);
  // When the browser takes the page's place (asked to, or opened from its bar in a window too narrow for both), a
  // full-page chat goes to the side so it stays in sight.
  const assistantFull = chatForm === 'full' && !(browserOpen && !folded && (browserWide || windowWidth < SIDE_MIN_WINDOW));
  const assistantOpen = Boolean(chatOpen) && !assistantFull;
  const beside = assistantOpen ? ASSISTANT_WIDTH : 0;
  const room = windowWidth - beside;
  const canSide = room >= SIDE_MIN_WINDOW;
  const wide = browserOpen && !folded && (browserWide || !canSide);
  const [minPane, maxPane] = paneLimits(room);
  const width = Math.min(maxPane, Math.max(minPane, paneWidth || Math.round((room - SIDEBAR) * 0.58)));
  return { assistantFull, assistantOpen, beside, room, canSide, tight, folded, wide, width, minPane, maxPane, pageHidden: wide || assistantFull };
}
