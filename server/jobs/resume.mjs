import { HttpError } from '../http.mjs';

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

// Resumes are stored as plain text only; the original file is not kept.
export async function extractResumeText({ name, mime, data }) {
  const type = kind(name || '', mime || '');
  if (!type) throw new HttpError(415, 'Upload a PDF, Word (.docx) or text resume.');
  if (!data?.length) throw new HttpError(400, 'The resume file is empty.');
  if (data.length > MAX_RESUME_BYTES) throw new HttpError(413, 'The resume file is larger than 8 MB.');
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
  if (text.length < 200) throw new HttpError(422, 'Almost no text was found in this resume. If it is a scanned image, export it as a text-based PDF or upload a .docx.');
  return { name: name || `resume.${type}`, mime: mime || (type === 'pdf' ? 'application/pdf' : type === 'docx' ? DOCX : 'text/plain'), size: data.length, text: text.slice(0, 60000) };
}
