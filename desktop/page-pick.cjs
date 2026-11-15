// Which row of a list is meant by some words. This runs inside web pages: the page script of browser-page.cjs
// carries its source, so it stands alone.
//
// The rows of a dropdown seldom read exactly as they are asked for: a country is listed as "+1 United States", a
// place as "Menlo Park, CA, United States". So the closest row wins: the one that reads just so, else the shortest
// one that starts with the words, else the shortest one that holds them, else the shortest one that holds every
// word. Among rows that read the same, the first.
function pickOption(names, wanted) {
  const plain = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = plain(wanted);
  if (!want) return -1;
  const rows = names.map(plain);
  const shortest = fits => {
    let best = -1;
    rows.forEach((row, index) => { if (row && fits(row) && (best < 0 || row.length < rows[best].length)) best = index; });
    return best;
  };
  const words = want.split(/[\s,;/()]+/).filter(Boolean);
  for (const fits of [row => row === want, row => row.startsWith(want), row => row.includes(want), row => words.length > 1 && words.every(word => row.includes(word))]) {
    const index = shortest(fits);
    if (index >= 0) return index;
  }
  return -1;
}

module.exports = { pickOption, PICK_SOURCE: pickOption.toString() };
