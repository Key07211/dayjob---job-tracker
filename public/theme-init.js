// Apply the saved theme before styles paint, so there is no flash of the wrong one.
(() => {
  let choice = 'system';
  try { choice = localStorage.getItem('dayjob-theme') || 'system'; } catch {}
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'night' : 'day';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
