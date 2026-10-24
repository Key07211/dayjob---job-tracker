// Apply the saved theme before styles paint, so there is no flash of the wrong one.
(() => {
  let choice = 'system';
  try { choice = localStorage.getItem('dayjob-theme') || 'system'; } catch {}
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'night' : 'day';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  // Motion follows Windows' Animation effects setting unless Settings says otherwise (src/dayjob/motion.js).
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotion = () => {
    let motion = 'system';
    try { motion = localStorage.getItem('dayjob-motion') || 'system'; } catch {}
    document.documentElement.dataset.motion = motion === 'reduce' || (motion !== 'full' && reduced.matches) ? 'reduce' : 'full';
  };
  applyMotion();
  reduced.addEventListener('change', applyMotion);
})();
