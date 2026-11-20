import { HttpError } from '../http.mjs';
import { resumeTerms } from './keywords.mjs';

export const MAX_RESUME_BYTES = 8 * 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function kind(name, mime) {
  const extension = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime === DOCX || extension === 'docx') return 'docx';
  if (/^text\//.test(mime || '') || ['txt', 'md', 'markdown'].includes(extension)) return 'text';
  return null;
}

export function tidy(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// What a resume file is served and attached as, whatever type the upload claimed for it.
const SERVED = { pdf: 'application/pdf', docx: DOCX, text: 'text/plain; charset=utf-8' };
export function resumeFileType(name, mime) {
  const type = kind(name || '', mime || '');
  return type ? { kind: type, mime: SERVED[type] } : null;
}

// Whether two resume texts are the same resume (one read from a PDF and one from its Word file, say): most of the
// shorter one's words are in the other.
export function sameResume(a, b) {
  const [small, large] = [resumeTerms(a), resumeTerms(b)].sort((x, y) => x.size - y.size);
  if (!small.size) return false;
  let shared = 0;
  for (const term of small) if (large.has(term)) shared += 1;
  return shared / small.size >= 0.6;
}

// The text is what the AI reads and what postings are matched against. The file itself is kept beside it (by the
// caller), so the same resume can be attached to an application form.
// what, min: the same reading for another kind of file (a cover letter template), which may be shorter.
export async function extractResumeText({ name, mime, data }, { what = 'resume', min = 200 } = {}) {
  const type = kind(name || '', mime || '');
  if (!type) throw new HttpError(415, `Upload a PDF, Word (.docx) or text ${what}.`);
  if (!data?.length) throw new HttpError(400, `The ${what} file is empty.`);
  if (data.length > MAX_RESUME_BYTES) throw new HttpError(413, `The ${what} file is larger than 8 MB.`);
  let text;
  try {
    if (type === 'pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(data));
      text = (await extractText(pdf, { mergePages: true })).text;
    } else if (type === 'docx') {
      const mammoth = (await import('mammoth')).default;
      text = (await mammoth.extractRawText({ buffer: data })).value;
    } else {
      text = data.toString('utf8').replace(/^\uFEFF/, '');
    }
  } catch (error) {
    throw new HttpError(422, `Could not read this ${type.toUpperCase()} file: ${error.message}`);
  }
  text = tidy(text);
  if (text.length < min) throw new HttpError(422, `Almost no text was found in this ${what}. If it is a scanned image, export it as a text-based PDF or upload a .docx.`);
  return { name: name || `resume.${type}`, mime: mime || (type === 'pdf' ? 'application/pdf' : type === 'docx' ? DOCX : 'text/plain'), size: data.length, text: text.slice(0, 60000) };
}
