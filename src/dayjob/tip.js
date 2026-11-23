// 小字说明: the sentences that used to stand under a setting. They are no longer on the page, which keeps to names
// and controls; each is the tooltip of the thing it explains (Tip.jsx writes them in the page, unseen). That thing
// is the label or the row the sentence is written in, or else what stands just before it (a heading, a switch), or
// else what it is written in. It must have no tooltip of its own: this one would take its place.
const HOSTS = 'label, .option-row, .check-line';
const told = new WeakMap(); // host -> the tips written on it

export function hostOf(tip) {
  const within = tip.closest(HOSTS);
  if (within) return within;
  let before = tip.previousElementSibling;
  while (before?.classList.contains('tip')) before = before.previousElementSibling;
  return before || tip.parentElement;
}

// Several sentences about one thing make one tooltip, a blank line between them.
function write(host) {
  const text = [...told.get(host) || []].map(tip => tip.textContent.trim()).filter(Boolean).join('\n\n');
  if (text) host.title = text;
  else host.removeAttribute('title');
}

// Puts a tip's words on what it explains. -> what takes them off again.
export function tell(tip) {
  const host = hostOf(tip);
  if (!host) return () => {};
  if (!told.has(host)) told.set(host, new Set());
  told.get(host).add(tip);
  write(host);
  return () => { told.get(host)?.delete(tip); write(host); };
}
