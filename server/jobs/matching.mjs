// Board searches are filtered by the boards themselves; company boards list
// every job, so Dayjob matches those against the saved searches locally.
const STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky',
  LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri',
  MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island',
  SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
  WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia',
};
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATES).map(([code, name]) => [name, code]));
const AREAS = {
  'bay area': ['san francisco', 'oakland', 'berkeley', 'san jose', 'palo alto', 'mountain view', 'menlo park', 'sunnyvale', 'redwood city',
    'santa clara', 'cupertino', 'emeryville', 'fremont', 'south san francisco', 'san mateo', 'foster city', 'burlingame'],
};

const words = text => (text || '').toLowerCase().replace(/[^a-z0-9+#.一-鿿]+/g, ' ').trim();
const has = (text, phrase) => ` ${words(text)} `.includes(` ${words(phrase)} `);

export function phrases(keywords) {
  return String(keywords || '').split(/,|\||\bOR\b|，/).map(part => part.trim()).filter(Boolean);
}

export function titleMatches(title, keywords) {
  const list = phrases(keywords);
  if (!list.length) return true;
  const text = ` ${words(title)} `;
  return list.some(phrase => words(phrase).split(' ').filter(Boolean).every(token => text.includes(` ${token} `)));
}

export function passesFilters(item, search) {
  const title = item.title || '';
  if (search.titleInclude?.length && !search.titleInclude.some(word => has(title, word))) return false;
  if (search.excludeKeywords?.some(word => has(title, word) || has(item.company, word))) return false;
  return true;
}

export function locationMatches(item, search) {
  if (search.isRemote) return item.isRemote === true || /remote/i.test(item.location || '');
  const wanted = (search.location || '').toLowerCase().trim();
  if (!wanted || ['united states', 'usa', 'us', 'anywhere'].includes(wanted)) return true;
  const where = (item.location || [item.city, item.state, item.country].filter(Boolean).join(', ')).toLowerCase();
  if (/remote/.test(where) && /remote/.test(wanted)) return true;
  const area = Object.entries(AREAS).find(([name]) => wanted.includes(name));
  if (area) return area[1].some(city => where.includes(city));
  const parts = wanted.split(',').map(part => part.trim()).filter(Boolean);
  const stateOf = part => STATE_BY_NAME[part] || (part.length === 2 && STATES[part.toUpperCase()] ? part.toUpperCase() : null);
  const state = stateOf(parts.at(-1));
  if (parts.length === 1 && state) {
    const tokens = where.split(',').map(part => part.trim());
    return tokens.includes(state.toLowerCase()) || tokens.includes(STATES[state]);
  }
  return where.includes(parts[0]);
}

export function freshEnough(item, search, now = new Date()) {
  if (!search.hoursOld || !item.datePosted) return true;
  const posted = Date.parse(item.datePosted.length === 10 ? `${item.datePosted}T23:59:59Z` : item.datePosted);
  return !Number.isFinite(posted) || now.getTime() - posted <= search.hoursOld * 3600e3;
}

export function companyJobMatches(item, search, now) {
  if (!titleMatches(item.title, search.keywords)) return false;
  if (!passesFilters(item, search)) return false;
  if (!locationMatches(item, search)) return false;
  if (search.jobType && item.jobType && !item.jobType.replace(/[\s-]/g, '').toLowerCase().includes(search.jobType)) return false;
  return freshEnough(item, search, now);
}
