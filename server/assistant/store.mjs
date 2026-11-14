// Conversations the user chose to keep. A conversation is only ever written here after "keep this conversation"
// or "archive"; until then it lives in memory and is gone when Dayjob closes. This is the only copy: the Claude Code
// engine runs with session persistence off, and the Claude API keeps nothing. An archived conversation is a kept
// one that is put away from the list (archived_at says since when).
//
// The table is made here on first use instead of in the numbered migrations, so it does not depend on the order
// other schema changes are released in.
const TABLE = `CREATE TABLE IF NOT EXISTS assistant_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  turns TEXT NOT NULL
)`;

export function createConversationStore(db) {
  db.exec(TABLE);
  const q = sql => db.prepare(sql);
  const parse = value => { try { const turns = JSON.parse(value); return Array.isArray(turns) ? turns : []; } catch { return []; } };
  // A removed or rewritten conversation is overwritten on disk, not just unlinked.
  function wiping(work) {
    const before = db.prepare('PRAGMA secure_delete').get()?.secure_delete ?? 0;
    db.exec('PRAGMA secure_delete = ON');
    try { return work(); } finally {
      db.exec(`PRAGMA secure_delete = ${before === 2 ? 'FAST' : before ? 'ON' : 'OFF'}`);
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy: the next checkpoint clears the log */ }
    }
  }
  return {
    list() {
      return q('SELECT id, title, created_at, updated_at, archived_at, turns FROM assistant_conversations ORDER BY updated_at DESC').all()
        .map(row => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at || null, turns: parse(row.turns).filter(turn => turn?.role !== 'compact').length }));
    },
    get(id) {
      const row = q('SELECT * FROM assistant_conversations WHERE id = ?').get(id);
      return row ? { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at || null, turns: parse(row.turns) } : null;
    },
    has: id => Boolean(q('SELECT 1 AS n FROM assistant_conversations WHERE id = ?').get(id)),
    save(conversation) {
      wiping(() => q(`INSERT INTO assistant_conversations (id, title, created_at, updated_at, archived_at, turns) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, archived_at = excluded.archived_at, turns = excluded.turns`)
        .run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt, conversation.archivedAt || null, JSON.stringify(conversation.turns)));
    },
    // Puts a stored conversation away (a time) or back in the list (null), without touching what was said.
    archive: (id, at) => q('UPDATE assistant_conversations SET archived_at = ? WHERE id = ?').run(at || null, id).changes > 0,
    remove: id => wiping(() => q('DELETE FROM assistant_conversations WHERE id = ?').run(id).changes > 0),
  };
}
