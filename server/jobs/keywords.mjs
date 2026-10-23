// Picks which resume a posting is scored against: the one that shares the most
// of the posting's keywords. Words that appear in nearly every posting (and
// EEO or benefits boilerplate) are ignored, title words count extra, and
// two-word phrases such as "machine learning" count on top of their words.
const STOP = new Set(`
a about above after again against all also am an and any are as at be because been before being below between both but by can could did do
does doing down during each either etc few for from further had has have having he her here hers him his how i if in into is it its itself
just me more most my no nor not now of off on once only or other our ours out over own per same she should so some such than that the their
theirs them then there these they this those through to too under until up upon us very via was we were what when where which while who whom
why will with within without would yes yet you your yours
able ability across additional along around based best candidate candidates company day days employee employees ensure environment
excellent experience experiences help high highly including job jobs join key knowledge level like looking make must new number
opportunity opportunities part people plus position preferred prefer required requirement requirements responsibilities responsible
role roles skill skills strong team teams time using use well work working world year years
equal employer race color colour religion sex sexual orientation gender identity national origin age disability veteran status protected
applicant applicants accommodation accommodations law laws pay salary range benefits benefit insurance medical dental vision 401k pto paid
leave holidays compensation bonus location office
`.trim().split(/\s+/));

const CJK = /[一-鿿]/;
const stem = word => (word.length > 4 && word.endsWith('s') && !word.endsWith('ss') && !/[.+#-]/.test(word) ? word.slice(0, -1) : word);

// Words in order, with null where punctuation, a stop word or a number breaks
// a phrase. Chinese text has no spaces, so it is split into character pairs.
// surface, when given, collects the first spelling seen for each stem.
function tokens(text, surface) {
  const out = [];
  for (const [word] of String(text || '').toLowerCase().matchAll(/[a-z0-9][a-z0-9+#]*(?:[.-][a-z0-9+#]+)*|[一-鿿]+|[^\sa-z0-9一-鿿]/g)) {
    if (word.length === 1 && !/[a-z0-9]/.test(word)) {
      out.push(null);
    } else if (CJK.test(word)) {
      for (let index = 0; index + 1 < word.length; index += 1) out.push(word.slice(index, index + 2));
      out.push(null);
    } else if (word.length < 2 || /^[\d.-]+$/.test(word) || STOP.has(word)) {
      out.push(null);
    } else {
      const term = stem(word);
      if (surface && !surface.has(term)) surface.set(term, word);
      out.push(term);
    }
  }
  return out;
}

function terms(text, surface) {
  const words = tokens(text, surface);
  const list = words.filter(Boolean);
  for (let index = 0; index + 1 < words.length; index += 1) {
    if (words[index] && words[index + 1] && !CJK.test(words[index])) list.push(`${words[index]} ${words[index + 1]}`);
  }
  return list;
}

export function resumeTerms(text) {
  return new Set(terms(text));
}

// Each term weighs as often as the posting repeats it (up to 3), plus 3 when
// it is in the title.
export function postingTerms({ title, description }) {
  const weights = new Map();
  const surface = new Map();
  for (const term of terms(description, surface)) weights.set(term, Math.min((weights.get(term) || 0) + 1, 3));
  for (const term of new Set(terms(title, surface))) weights.set(term, (weights.get(term) || 0) + 3);
  return { weights, surface };
}

export function overlap({ weights, surface }, resume) {
  let total = 0;
  let shared = 0;
  const matched = [];
  for (const [term, weight] of weights) {
    total += weight;
    if (resume.has(term)) { shared += weight; matched.push([term, weight]); }
  }
  const words = matched.filter(([term]) => !term.includes(' ')).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term]) => surface.get(term) || term);
  return { overlap: total ? Math.round((shared / total) * 1000) / 1000 : 0, matched: words };
}

// resumes: [{ id, uploadedAt, terms }]. Ties go to the newest upload.
export function rankResumes(posting, resumes) {
  const wanted = postingTerms(posting);
  return resumes.map(resume => ({ id: resume.id, uploadedAt: resume.uploadedAt, ...overlap(wanted, resume.terms) }))
    .sort((a, b) => b.overlap - a.overlap || String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}
