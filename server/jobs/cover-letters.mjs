import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.mjs';

// 求职信: the samples the user uploaded (cover letters of their own, which new ones are written from), and the
// letters written for postings.
//
// A letter is kept twice: its text in the database (what the assistant reads back, what the window shows and what
// an application form is given), and a file in the cover letter folder, <data folder>/cover-letters, named after
// the company and the job, for the user to open, send or print. The file is a PDF when Dayjob can make one (the
// desktop app lays it out), a text file otherwise. One letter for each posting: writing it again replaces it.
//
// A sample is kept as text only: the letters follow its wording and its structure, not its page layout.
export const COVER_LETTER_FOLDER = 'cover-letters';
export const LETTER_MAX = 6000;
export const SAMPLE_MAX = 20000;
export const MAX_SAMPLES = 8;
// How much of one sample the assistant is given: a letter is a page, and eight of them are read together.
export const SAMPLE_GIVEN = 6000;

// A file name out of a company and a job title: nothing Windows refuses, no dots or spaces at its ends.
export function letterFileBase(company, title) {
  const part = value => String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '');
  const name = [part(company).slice(0, 60), part(title).slice(0, 80)].filter(Boolean).join(' - ') || 'Cover letter';
  // Names Windows keeps for devices (CON, NUL, COM1, …) are not used as they stand.
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `${name} letter` : name;
}

// dir: the cover letter folder, or null when nothing is kept on disk (a database in memory).
// makePdf(text, title) -> Buffer: lays a letter out as a PDF; without it letters are saved as text files.
export function createCoverLetters({ db, repo, dir = null, makePdf = null, now = () => new Date(), log = console.warn }) {
  const q = sql => db.prepare(sql);
  const stamp = () => now().toISOString();
  const pathOf = file => (dir && file ? path.join(dir, path.basename(file)) : null);
  const onDisk = file => { const where = pathOf(file); try { return Boolean(where) && fs.statSync(where).isFile(); } catch { return false; } };
  const view = (row, withText = false) => (row ? { id: row.id, postingId: row.posting_id, company: row.company, title: row.title, file: row.file || null,
    hasFile: onDisk(row.file), characters: row.text.length, createdAt: row.created_at, updatedAt: row.updated_at, ...(withText ? { text: row.text } : {}) } : null);
  const row = id => q('SELECT * FROM cover_letters WHERE id = ?').get(id) || null;
  const rowFor = postingId => q('SELECT * FROM cover_letters WHERE posting_id = ?').get(postingId) || null;

  // A name in the folder no other letter has: "Company - Title.pdf", then "Company - Title (2).pdf".
  function freeName(base, extension, own) {
    for (let count = 1; count < 200; count += 1) {
      const name = `${base}${count > 1 ? ` (${count})` : ''}.${extension}`;
      const taken = q('SELECT id FROM cover_letters WHERE lower(file) = lower(?)').get(name);
      if ((!taken || taken.id === own) && (taken?.id === own || !onDisk(name))) return name;
    }
    return `${base} ${randomUUID().slice(0, 8)}.${extension}`;
  }
  function write(file, data) {
    fs.mkdirSync(dir, { recursive: true });
    const where = pathOf(file);
    const draft = `${where}.${randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(draft, data);
    fs.renameSync(draft, where);
  }
  function unlink(file) {
    const where = pathOf(file);
    if (!where) return;
    try { fs.unlinkSync(where); } catch (error) { if (error.code !== 'ENOENT') log(`[dayjob] cover letters: could not remove ${path.basename(where)}: ${error.message}`); }
  }

  // The letter for a posting, written or written again. -> { letter, previous } where previous is what restore()
  // needs to put things back as they were (null when the posting had no letter).
  async function save({ posting, text }) {
    const letter = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (letter.length < 200) throw new HttpError(400, 'A cover letter needs at least a few sentences (200 characters).');
    if (letter.length > LETTER_MAX) throw new HttpError(400, `A cover letter can be up to ${LETTER_MAX} characters.`);
    const held = rowFor(posting.id);
    const id = held?.id || randomUUID();
    let file = null;
    let before = null;
    if (dir) {
      let data = null;
      let extension = 'txt';
      if (makePdf) {
        try { data = await makePdf(letter, `Cover Letter - ${[posting.company, posting.title].filter(Boolean).join(' - ')}`); extension = 'pdf'; }
        catch (error) { log(`[dayjob] cover letters: the PDF could not be made, a text file is kept instead: ${error.message}`); }
      }
      if (!data) data = Buffer.from(`\uFEFF${letter}\n`, 'utf8');
      if (held?.file && onDisk(held.file)) { try { before = fs.readFileSync(pathOf(held.file)); } catch { before = null; } }
      file = held?.file && held.file.toLowerCase().endsWith(`.${extension}`) ? held.file : freeName(letterFileBase(posting.company, posting.title), extension, id);
      try {
        write(file, data);
        if (held?.file && held.file !== file) unlink(held.file);
      } catch (error) { throw new HttpError(500, `The letter could not be saved in the cover letter folder: ${error.message}`); }
    }
    const at = stamp();
    if (held) q('UPDATE cover_letters SET company = ?, title = ?, text = ?, file = ?, updated_at = ? WHERE id = ?').run(posting.company || '', posting.title || '', letter, file, at, id);
    else q('INSERT INTO cover_letters (id, posting_id, company, title, text, file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, posting.id, posting.company || '', posting.title || '', letter, file, at, at);
    return { letter: view(row(id), true), previous: held ? { row: held, data: before } : null };
  }
  // Takes back a save: the letter it replaced comes back, or the new one goes.
  function restore(id, previous) {
    const current = row(id);
    if (!current) return;
    if (!previous) { remove(id); return; }
    if (current.file && current.file !== previous.row.file) unlink(current.file);
    if (dir && previous.row.file && previous.data) { try { write(previous.row.file, previous.data); } catch (error) { log(`[dayjob] cover letters: could not put the earlier file back: ${error.message}`); } }
    q('UPDATE cover_letters SET company = ?, title = ?, text = ?, file = ?, updated_at = ? WHERE id = ?')
      .run(previous.row.company, previous.row.title, previous.row.text, previous.row.file, previous.row.updated_at, id);
  }
  // Only the letter's own file goes, and only from the cover letter folder.
  function remove(id) {
    const current = row(id);
    if (!current) return false;
    unlink(current.file);
    q('DELETE FROM cover_letters WHERE id = ?').run(id);
    return true;
  }

  // 样本: in the order they were added.
  const sampleView = (item, withText = false) => ({ id: item.id, name: item.name, characters: item.text.length, createdAt: item.created_at,
    ...(withText ? { text: item.text } : { preview: item.text.slice(0, 600) }) });
  const samples = (withText = false) => q('SELECT * FROM cover_letter_samples ORDER BY created_at, rowid').all().map(item => sampleView(item, withText));
  // The same letter uploaded again is kept once (under its newest name).
  function addSample({ name = '', text }) {
    const value = String(text || '').replace(/\r\n?/g, '\n').trim().slice(0, SAMPLE_MAX);
    if (value.length < 80) throw new HttpError(422, 'Almost no text was found in this sample. A cover letter sample needs at least a few sentences.');
    const label = String(name || '').slice(0, 200);
    const same = q('SELECT id FROM cover_letter_samples WHERE text = ?').get(value);
    if (same) {
      if (label) q('UPDATE cover_letter_samples SET name = ? WHERE id = ?').run(label, same.id);
      return sampleView(q('SELECT * FROM cover_letter_samples WHERE id = ?').get(same.id));
    }
    if (q('SELECT count(*) AS n FROM cover_letter_samples').get().n >= MAX_SAMPLES) throw new HttpError(409, `Dayjob keeps up to ${MAX_SAMPLES} cover letter samples. Delete one to add another.`);
    const id = randomUUID();
    q('INSERT INTO cover_letter_samples (id, name, text, created_at) VALUES (?, ?, ?, ?)').run(id, label, value, stamp());
    return sampleView(q('SELECT * FROM cover_letter_samples WHERE id = ?').get(id));
  }
  const removeSample = id => q('DELETE FROM cover_letter_samples WHERE id = ?').run(id).changes > 0;

  return {
    folder: dir,
    list: () => q('SELECT * FROM cover_letters ORDER BY updated_at DESC, id').all().map(item => view(item)),
    get: id => view(row(id), true),
    forPosting: (postingId, withText = false) => view(rowFor(postingId), withText),
    // Where a letter's file is, when it is there.
    filePath(id) { const current = row(id); return current && onDisk(current.file) ? pathOf(current.file) : null; },
    save, restore, remove, samples, addSample, removeSample,
  };
}
