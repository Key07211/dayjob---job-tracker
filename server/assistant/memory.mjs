import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.mjs';

// What the user wants the assistant to keep in mind from one conversation to the next: standing answers for
// application forms ("Protected veteran: I am not one"), and how they like things done. The notes are kept in the
// Dayjob database on this computer, the user reads and edits them under Settings, and the whole list goes to the
// model with a conversation, which is why a password has no place in it.
export const MEMORY_MAX = 60;
export const MEMORY_TEXT = 400;
export const MEMORY_EMPTY = 'Your memory is empty now: the notes you were given earlier in this conversation no longer apply.';
const SECRET = /(pass(word|code)|passwd|密码|口令)\s*(is|are|:|=|：|是|为)\s*\S/i;

export function createMemory(repo, now = () => new Date()) {
  const read = () => {
    const saved = repo.getMeta('assistantMemory');
    return Array.isArray(saved) ? saved.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string') : [];
  };
  const write = items => { repo.setMeta('assistantMemory', items); };
  function clean(value) {
    if (typeof value !== 'string') throw new HttpError(400, 'A note is a line of text.');
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length < 2) throw new HttpError(400, 'Write the note first.');
    if (text.length > MEMORY_TEXT) throw new HttpError(400, `A note can be up to ${MEMORY_TEXT} characters.`);
    if (SECRET.test(text)) throw new HttpError(400, 'Passwords do not belong in the assistant\'s memory, which is sent to the model. Keep them in the password vault.');
    return text;
  }
  return {
    list: read,
    add(value, by = 'user') {
      const text = clean(value);
      const items = read();
      const same = items.find(item => item.text.toLowerCase() === text.toLowerCase());
      if (same) return same;
      if (items.length >= MEMORY_MAX) throw new HttpError(409, `The assistant's memory holds up to ${MEMORY_MAX} notes. Remove one first.`);
      const item = { id: randomUUID().slice(0, 8), text, by: by === 'assistant' ? 'assistant' : 'user', at: now().toISOString() };
      write([...items, item]);
      return item;
    },
    update(id, value) {
      const text = clean(value);
      const items = read();
      const item = items.find(entry => entry.id === id);
      if (!item) throw new HttpError(404, 'Note not found.');
      item.text = text;
      item.at = now().toISOString();
      write(items);
      return item;
    },
    // Takes a note out; gives back the note and where it was, for putting it back.
    remove(id) {
      const items = read();
      const index = items.findIndex(entry => entry.id === id);
      if (index < 0) return null;
      const [item] = items.splice(index, 1);
      write(items);
      return { item, index };
    },
    restore({ item, index }) {
      const items = read();
      if (items.some(entry => entry.id === item.id)) return;
      items.splice(Math.min(index, items.length), 0, item);
      write(items);
    },
    // The list as the model reads it, at the head of a message; nothing when there are no notes.
    note() {
      const items = read();
      if (!items.length) return '';
      return ['Your memory: what the user asked you to keep in mind (standing answers for application forms, preferences). Use these without asking again; the id in brackets is for forget.',
        ...items.map(item => `- [${item.id}] ${item.text}`)].join('\n');
    },
  };
}
