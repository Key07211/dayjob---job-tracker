import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.mjs';

// 成绩单: the user's transcripts, kept as PDF files in the transcript folder, <data folder>/transcripts, so that
// an application form that asks for one can be given it.
//
// The folder is where they are: a PDF uploaded in the window is written there, and a PDF the user puts there
// themselves is found the next time the list is read. Beside each file the database keeps what the folder cannot
// say: a note on what the transcript is (the school, the degree) and which one goes into a form that does not say
// which it wants. A file taken out of the folder is gone from the list too.
//
// A transcript's contents never leave this computer except into the form it is attached to: nothing reads its
// text, and a model is told its file name and its note only.
export const TRANSCRIPT_FOLDER = 'transcripts';
export const MAX_TRANSCRIPTS = 8;
export const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
export const TRANSCRIPT_NOTE_MAX = 80;
const MIME = 'application/pdf';
const isPdf = data => data.length > 4 && data.subarray(0, 1024).includes('%PDF-');

// A file name for the folder out of the name a file came with: nothing Windows refuses, and always .pdf.
export function transcriptFileName(name) {
  const base = String(name || '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 120) || 'Transcript';
  return `${/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) ? `${base} transcript` : base}.pdf`;
}

// What a form's field and a transcript's note or name both say, for telling which transcript a field wants: the
// level of study, and the words that are not about transcripts in general.
const LEVELS = [/undergrad|bachelor|\bb\.?[as]\b|本科|学士/, /(^|[^r])graduate|master|\bm\.?[as]\b|\bmba\b|硕士|研究生/, /ph\.?d|doctor|博士/, /high school|secondary|高中/];
const COMMON = new Set(['transcript', 'transcripts', 'official', 'unofficial', 'academic', 'record', 'records', 'college', 'university', 'school', 'copy', 'scan',
  'final', 'pdf', 'the', 'and', 'for', 'your', 'upload', 'attach', 'file', 'files', 'most', 'recent', 'please', 'grade', 'grades', 'report']);
const said = text => String(text || '').toLowerCase().replace(/[_\-.,()[\]/\\]+/g, ' ');
const tokens = text => [...new Set(said(text).match(/[a-z]{3,}|\d{4}|[一-鿿]{2,}/g) || [])].filter(word => !COMMON.has(word) && !/^成绩单?$/.test(word));
const levelsOf = text => LEVELS.map(level => level.test(said(text)));

// dir: the transcript folder, or null when nothing is kept on disk (a database in memory keeps the files in memory too).
export function createTranscripts({ db, dir = null, now = () => new Date() }) {
  const q = sql => db.prepare(sql);
  const memory = new Map();
  const pathOf = file => path.join(dir, path.basename(file));
  const store = dir ? {
    names() {
      try { return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && /\.pdf$/i.test(entry.name)).map(entry => entry.name); } catch { return []; }
    },
    size(file) { try { const found = fs.statSync(pathOf(file)); return found.isFile() ? found.size : null; } catch { return null; } },
    read(file) { try { return fs.readFileSync(pathOf(file)); } catch { return null; } },
    write(file, data) {
      fs.mkdirSync(dir, { recursive: true });
      const draft = `${pathOf(file)}.${randomUUID().slice(0, 8)}.tmp`;
      fs.writeFileSync(draft, data);
      fs.renameSync(draft, pathOf(file));
    },
    remove(file) { try { fs.unlinkSync(pathOf(file)); } catch { /* already gone */ } },
  } : {
    names: () => [...memory.keys()],
    size: file => memory.get(file)?.length ?? null,
    read: file => memory.get(file) ?? null,
    write: (file, data) => { memory.set(file, Buffer.from(data)); },
    remove: file => { memory.delete(file); },
  };
  const view = row => ({ id: row.id, name: row.file, note: row.note, isDefault: Boolean(row.is_default), size: row.size, addedAt: row.added_at });

  // The list follows the folder: a PDF put there by hand gets a row, a row whose file is gone is dropped. A file
  // that is too big, or that only has a PDF's name, is left where it is and not listed.
  function sync() {
    const rows = q('SELECT * FROM transcripts').all();
    const names = store.names();
    const lower = new Set(names.map(name => name.toLowerCase()));
    for (const row of rows) if (!lower.has(row.file.toLowerCase())) q('DELETE FROM transcripts WHERE id = ?').run(row.id);
    const known = new Set(rows.map(row => row.file.toLowerCase()));
    let count = rows.filter(row => lower.has(row.file.toLowerCase())).length;
    for (const name of names.sort()) {
      if (known.has(name.toLowerCase()) || count >= MAX_TRANSCRIPTS) continue;
      const size = store.size(name);
      if (!size || size > MAX_TRANSCRIPT_BYTES) continue;
      const data = store.read(name);
      if (!data || !isPdf(data)) continue;
      q('INSERT INTO transcripts (id, file, note, is_default, size, added_at) VALUES (?, ?, ?, 0, ?, ?)').run(randomUUID(), name, '', size, now().toISOString());
      count += 1;
    }
    for (const row of q('SELECT id, file, size FROM transcripts').all()) {
      const size = store.size(row.file);
      if (size && size !== row.size) q('UPDATE transcripts SET size = ? WHERE id = ?').run(size, row.id);
    }
  }
  function list() {
    sync();
    return q('SELECT * FROM transcripts ORDER BY added_at DESC, rowid DESC').all().map(view);
  }
  const row = id => { sync(); return q('SELECT * FROM transcripts WHERE id = ?').get(id) || null; };

  // A name in the folder no other transcript has: "Transcript.pdf", then "Transcript (2).pdf".
  function freeName(name) {
    const base = name.replace(/\.pdf$/i, '');
    const taken = new Set(store.names().map(item => item.toLowerCase()));
    for (let count = 1; count < 200; count += 1) {
      const candidate = `${base}${count > 1 ? ` (${count})` : ''}.pdf`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} ${randomUUID().slice(0, 8)}.pdf`;
  }
  function add({ name = '', data, note = '' }) {
    if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, 'The transcript file is empty.');
    if (data.length > MAX_TRANSCRIPT_BYTES) throw new HttpError(413, `The transcript file is larger than ${MAX_TRANSCRIPT_BYTES / 1024 / 1024} MB.`);
    if (!isPdf(data)) throw new HttpError(415, 'A transcript is kept as a PDF file. Save or scan it as a PDF first.');
    if (list().length >= MAX_TRANSCRIPTS) throw new HttpError(409, `You can keep up to ${MAX_TRANSCRIPTS} transcripts. Delete one before adding another.`);
    const file = freeName(transcriptFileName(name));
    store.write(file, data);
    const id = randomUUID();
    q('INSERT INTO transcripts (id, file, note, is_default, size, added_at) VALUES (?, ?, ?, 0, ?, ?)').run(id, file, String(note || '').trim().slice(0, TRANSCRIPT_NOTE_MAX), data.length, now().toISOString());
    return view(row(id));
  }
  // note: what the transcript is. isDefault: true makes it the one a form gets when it does not say which it
  // wants (and no other is then); false takes the mark off.
  function update(id, { note, isDefault } = {}) {
    const current = row(id);
    if (!current) return null;
    if (note !== undefined) q('UPDATE transcripts SET note = ? WHERE id = ?').run(String(note || '').trim().slice(0, TRANSCRIPT_NOTE_MAX), id);
    if (isDefault !== undefined) {
      if (isDefault) q('UPDATE transcripts SET is_default = 0').run();
      q('UPDATE transcripts SET is_default = ? WHERE id = ?').run(isDefault ? 1 : 0, id);
    }
    return view(row(id));
  }
  function remove(id) {
    const current = row(id);
    if (!current) return false;
    store.remove(current.file);
    q('DELETE FROM transcripts WHERE id = ?').run(id);
    return true;
  }
  // The file itself, for the form it goes into and for the user to look at. Never for a model.
  function file(id) {
    const current = row(id);
    const data = current ? store.read(current.file) : null;
    return data ? { id: current.id, name: current.file, mime: MIME, size: data.length, data } : null;
  }

  // Which transcripts go into a field. ids: the ones asked for, in that order. Otherwise one: the only one there
  // is; else the one whose note or name says what the field's label says (a level of study, a school's name);
  // else the one marked as the default; else the newest. `others` are the ones left out, for saying so.
  // -> { transcripts: [{ id, name, note }], reason: 'chosen' | 'only' | 'label' | 'default' | 'newest', others } or
  //    { transcripts: [], reason: 'none' | 'unknown' }
  function pick({ label = '', section = '', ids = null } = {}) {
    const all = list();
    const brief = item => ({ id: item.id, name: item.name, note: item.note });
    if (!all.length) return { transcripts: [], reason: 'none' };
    if (ids?.length) {
      const chosen = ids.map(id => all.find(item => item.id === id));
      if (chosen.some(item => !item)) return { transcripts: [], reason: 'unknown', others: all.map(brief) };
      return { transcripts: chosen.map(brief), reason: 'chosen', others: all.filter(item => !chosen.includes(item)).map(brief) };
    }
    const done = (item, reason) => ({ transcripts: [brief(item)], reason, others: all.filter(other => other !== item).map(brief) });
    if (all.length === 1) return done(all[0], 'only');
    const asked = `${label} ${section}`;
    const wanted = levelsOf(asked);
    const words = said(asked);
    const scored = all.map(item => {
      const own = `${item.note} ${item.name.replace(/\.pdf$/i, '')}`;
      const levels = levelsOf(own);
      return { item, score: wanted.reduce((sum, want, at) => sum + (want && levels[at] ? 2 : 0), 0) + tokens(own).filter(word => words.includes(word)).length };
    }).sort((a, b) => b.score - a.score);
    if (scored[0].score > 0 && scored[0].score > scored[1].score) return done(scored[0].item, 'label');
    const marked = all.find(item => item.isDefault);
    return marked ? done(marked, 'default') : done(all[0], 'newest');
  }

  return { folder: dir, list, add, update, remove, file, pick,
    get(id) { const current = row(id); return current ? view(current) : null; },
    filePath(id) { const current = row(id); return dir && current && store.size(current.file) ? pathOf(current.file) : null; } };
}
