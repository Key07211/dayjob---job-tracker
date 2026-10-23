// How a monthly target becomes weekly tasks. No Node imports: the interface
// uses this too, to preview the split while goals are edited.
const pad = value => String(value).padStart(2, '0');
export const monthKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
export const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// Local calendar weeks of a month; `end` is the next week's start.
export function monthWeeks(month) {
  const [year, number] = month.split('-').map(Number);
  const days = new Date(year, number, 0).getDate();
  const weeks = [];
  for (let first = 1; first <= days;) {
    const monday = (new Date(year, number - 1, first).getDay() + 6) % 7;
    const last = Math.min(days, first + 6 - monday);
    weeks.push({ start: new Date(year, number - 1, first), end: new Date(year, number - 1, last + 1), days: last - first + 1 });
    first = last + 1;
  }
  return { days, weeks };
}

export function splitTarget(target, weeks, days) {
  const exact = weeks.map(week => (target * week.days) / days);
  const shares = exact.map(Math.floor);
  let left = target - shares.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => [value - shares[index], index]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, index] of order) {
    if (left <= 0) break;
    shares[index] += 1;
    left -= 1;
  }
  return shares;
}
