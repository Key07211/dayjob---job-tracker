// The browser and the assistant open as layers over the page, at the right of the window (dayjob.css, "layers at
// the right"). This is the right edge of what is still in sight of the page: the left edge of the leftmost layer,
// or the window's edge with none open. Menus and pickers that open from the page keep to the left of it, because
// the browser's page is a native view drawn over everything in the window.
export function pageRight() {
  let right = window.innerWidth;
  for (const layer of document.querySelectorAll('.browser-layer, .assistant-pane')) right = Math.min(right, layer.getBoundingClientRect().left);
  return right;
}

// While a layer is open the window's own scroll bar is put away (html.layered): it belongs to the page behind and
// would stand at the right of the layers. The page must not grow into the freed strip, so the strip is kept as
// --page-bar on the root (dayjob.css gives it back as a margin). Returns the function that undoes it.
export function holdPageWidth() {
  const root = document.documentElement;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-200px;width:80px;height:80px;overflow:scroll';
  document.body.append(probe);
  const bar = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  // A page that had a bar keeps the strip; one that fits the window has none, as with nothing open.
  const fit = () => root.style.setProperty('--page-bar', root.scrollHeight > window.innerHeight ? `${bar}px` : '0px');
  fit();
  root.classList.add('layered');
  const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  watch?.observe(document.body);
  window.addEventListener('resize', fit);
  return () => {
    watch?.disconnect();
    window.removeEventListener('resize', fit);
    root.classList.remove('layered');
    root.style.removeProperty('--page-bar');
  };
}
