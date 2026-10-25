// When the day and night themes take over by the clock. public/theme-init.js repeats this before the page paints,
// and a test keeps the two the same.
export const DEFAULT_HOURS = Object.freeze({ day: '07:00', night: '19:00' });
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutes = value => {
  const match = CLOCK.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

export function parseHours(value) {
  const day = minutes(value?.day) === null ? DEFAULT_HOURS.day : value.day;
  const night = minutes(value?.night) === null ? DEFAULT_HOURS.night : value.night;
  return { day, night };
}

// Night from the night time until the day time, across midnight; the same two times mean always day.
export function nightAt(date, hours) {
  const { day, night } = parseHours(hours);
  const now = date.getHours() * 60 + date.getMinutes();
  const from = minutes(night);
  const until = minutes(day);
  if (from === until) return false;
  return from > until ? now >= from || now < until : now >= from && now < until;
}

// The next minute at which the theme changes by itself, for the clock's sun and moon.
export function nextTurn(date, hours) {
  const { day, night } = parseHours(hours);
  const now = date.getHours() * 60 + date.getMinutes();
  const ahead = target => (minutes(target) - now + 1440) % 1440 || 1440;
  return Math.min(ahead(day), ahead(night));
}
