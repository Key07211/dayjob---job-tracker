// Apply the saved theme before styles paint, so there is no flash of the wrong one. By the clock (the default) it
// is night from the night time until the day time; src/dayjob/daynight.js holds the same rule for the running page.
// By the clock, a turn of the header's day/night switch holds until the clock's next turn (src/dayjob/theme.js).
// From 0.11.0 the theme follows the clock: the first start of that version moves an earlier choice over to it once.
(() => {
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const minutes = value => { const match = clock.exec(String(value || '')); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
  let choice = 'time';
  let hours = null;
  let hold = null;
  try {
    if (!localStorage.getItem('dayjob-theme-clock')) {
      localStorage.setItem('dayjob-theme', 'time');
      localStorage.setItem('dayjob-theme-clock', '1');
    }
    choice = localStorage.getItem('dayjob-theme') || 'time';
    hours = JSON.parse(localStorage.getItem('dayjob-theme-hours') || 'null');
    hold = JSON.parse(localStorage.getItem('dayjob-theme-hold') || 'null');
  } catch {}
  const now = new Date();
  const at = now.getHours() * 60 + now.getMinutes();
  const from = minutes(hours && hours.night) ?? minutes('19:00');
  const until = minutes(hours && hours.day) ?? minutes('07:00');
  const held = hold && typeof hold.night === 'boolean' && Number.isFinite(hold.until) && hold.until > now.getTime();
  const byClock = held ? hold.night : from === until ? false : from > until ? at >= from || at < until : at >= from && at < until;
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    || (!['dark', 'light', 'system'].includes(choice) && byClock);
  document.documentElement.dataset.theme = dark ? 'night' : 'day';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
