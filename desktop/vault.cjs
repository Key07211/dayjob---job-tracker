const fs = require('node:fs');
const { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } = require('node:crypto');

// 密码保管: sign-ins for job sites, kept in one file on this computer with each
// password encrypted by the operating system (on Windows, DPAPI, tied to the
// Windows account). A password goes into the login form of its own site in the
// Dayjob browser, and to the Settings page only when the user asks there to see
// the passwords of the open vault: never to the local server or its API, and
// never to Claude.
//
// The vault can also have its own password (开箱密码). It guards the vault in
// Dayjob: while it is locked nothing is listed, shown, changed, imported or
// deleted, but saved passwords are still filled in on their sites, so the lock
// never gets in the way of signing in. It opens with that password and closes
// again when Dayjob quits, the computer locks or sleeps, or the user closes it.
// Neither password is ever stored, only a check value sealed with a key made
// from the vault password (scrypt, AES-256-GCM).
//
// Before 0.20.0 a vault password also sealed each saved password with that key
// (wrapped), so a locked vault could fill nothing. Those are opened with it and
// sealed by the system alone the next time the vault is opened.
const MAX_ENTRIES = 2000;
// 6 to 32 letters or digits.
const LOCK_RULE = /^[A-Za-z0-9]{6,32}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// After this many wrong vault passwords in a row, the next try waits.
const TRIES = 5;
const WAIT_MS = 30000;
const CHECK = 'dayjob-vault';

class VaultError extends Error {}
const fail = message => { throw new VaultError(message); };

// The site a sign-in belongs to, as a host name: a pasted link, a host, or a
// domain that also covers its subdomains (linkedin.com covers www.linkedin.com).
function siteOf(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  let url;
  try { url = new URL(/^[a-z][\w+.-]*:\/\//.test(text) ? text : `https://${text}`); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.replace(/^www\./, '');
  return /^[a-z0-9.-]+$/.test(host) && (host.includes('.') || host === 'localhost') && !host.startsWith('.') && !host.endsWith('.') ? host : null;
}
const covers = (site, host) => host === site || host.endsWith(`.${site}`);

// A CSV file as rows of fields: quoted fields may hold commas, line breaks and doubled quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; } else if (char === '"') quoted = false; else field += char;
    } else if (char === '"' && !field) quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  row.push(field);
  if (row.some(value => value !== '')) rows.push(row);
  return rows;
}
// The sign-ins in a browser's password export: Microsoft Edge and Chrome write name,url,username,password,note;
// Firefox, Safari and password managers name the same columns a little differently.
const COLUMNS = {
  url: ['url', 'origin', 'origin_url', 'website', 'web site', 'login_uri', 'login uri', 'hostname', '网址', '网站'],
  username: ['username', 'user name', 'login', 'login_username', 'user', 'email', '用户名', '账号'],
  password: ['password', 'login_password', '密码'],
};
function readPasswordCsv(text) {
  const [header, ...rows] = parseCsv(text);
  const names = (header || []).map(name => name.trim().toLowerCase());
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([key, options]) => [key, names.findIndex(name => options.includes(name))]));
  if (at.url < 0 || at.password < 0) fail('This file is not a password export from a browser: it needs url and password columns.');
  return rows.map(row => ({ url: row[at.url] ?? '', username: at.username < 0 ? '' : row[at.username] ?? '', password: row[at.password] ?? '' }));
}

const derive = (password, salt) => new Promise((resolve, reject) => scrypt(password, salt, 32, SCRYPT, (error, key) => (error ? reject(error) : resolve(key))));
function wrap(key, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
function unwrap(key, value) {
  const data = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

function createVault({ file, safeStorage, now = () => new Date(), clock = () => Date.now() }) {
  let entries = [];
  // The vault password's salt and a check value sealed with its key.
  let lock = null;
  let key = null;
  let misses = 0;
  let waitUntil = 0;
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    entries = (Array.isArray(stored.entries) ? stored.entries : []).filter(entry => entry && typeof entry.id === 'string' && siteOf(entry.site) && typeof entry.secret === 'string');
    if (typeof stored.lock?.salt === 'string' && typeof stored.lock?.check === 'string') lock = { salt: stored.lock.salt, check: stored.lock.check };
  } catch { /* none saved yet */ }

  function persist() {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 2, entries, ...(lock ? { lock } : {}) }, null, 1), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  const available = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  const locked = () => Boolean(lock) && !key;
  const mustBeOpen = () => { if (locked()) fail('Open the password vault with its password first.'); };
  const seal = text => {
    if (!available()) fail('This computer cannot encrypt saved passwords, so none can be saved.');
    return safeStorage.encryptString(text).toString('base64');
  };
  // The saved password itself; one from before 0.20.0 needs the key it is wrapped in (the open vault's, or one just checked).
  const plain = (entry, withKey = key) => {
    const opened = safeStorage.decryptString(Buffer.from(entry.secret, 'base64'));
    return entry.wrapped ? unwrap(withKey, opened) : opened;
  };
  const shown = ({ id, site, username, createdAt, updatedAt, usedAt }) => ({ id, site, username, createdAt, updatedAt, usedAt: usedAt || null });
  // A saved password from before 0.20.0 still sealed with the vault password: it fills only once that has opened it.
  const waiting = entry => entry.wrapped && !key;
  // Opened with the vault password once, every password from before 0.20.0 is sealed by the system alone.
  function release(withKey) {
    const old = entries.filter(entry => entry.wrapped);
    if (!old.length) return;
    old.forEach(entry => { entry.secret = seal(plain(entry, withKey)); delete entry.wrapped; });
    persist();
  }
  const find = id => entries.find(entry => entry.id === id) || fail('No such saved password.');

  // While the vault is closed, not even its sites and user names are listed.
  function list() {
    return { available: available(), lock: Boolean(lock), locked: locked(), count: entries.length,
      entries: locked() ? [] : entries.map(shown).sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username)) };
  }
  // Adds a sign-in, or changes one; an empty password keeps the saved one.
  function save(input) {
    mustBeOpen();
    const site = siteOf(input?.site) || fail('Enter the site as a web address, such as myworkdayjobs.com.');
    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    if (!username || username.length > 200) fail('Enter the user name or email, up to 200 characters.');
    const password = typeof input?.password === 'string' ? input.password : '';
    if (password.length > 500) fail('The password must be 500 characters or fewer.');
    const at = now().toISOString();
    const existing = input.id ? find(input.id) : entries.find(entry => entry.site === site && entry.username === username);
    if (existing) {
      if (entries.some(entry => entry !== existing && entry.site === site && entry.username === username)) fail('That site already has a saved password for this user name.');
      if (password) delete existing.wrapped;
      Object.assign(existing, { site, username, updatedAt: at }, password ? { secret: seal(password) } : {});
      persist();
      return shown(existing);
    }
    if (!password) fail('Enter the password.');
    if (entries.length >= MAX_ENTRIES) fail(`Up to ${MAX_ENTRIES} passwords can be saved.`);
    const entry = { id: randomUUID(), site, username, secret: seal(password), createdAt: at, updatedAt: at, usedAt: null };
    entries.push(entry);
    persist();
    return shown(entry);
  }
  // Many sign-ins at once, from a browser's export. Each new one is added, a saved one with another password is
  // updated, and the counts say what was left out and why. Only the counts go back.
  function importMany(rows) {
    mustBeOpen();
    if (!available()) fail('This computer cannot encrypt saved passwords, so none can be saved.');
    const result = { added: 0, updated: 0, same: 0, skipped: { site: 0, username: 0, password: 0, full: 0 } };
    const at = now().toISOString();
    for (const row of Array.isArray(rows) ? rows : []) {
      const site = siteOf(row?.url);
      const username = typeof row?.username === 'string' ? row.username.trim() : '';
      const password = typeof row?.password === 'string' ? row.password : '';
      if (!site) { result.skipped.site += 1; continue; }
      if (!username || username.length > 200) { result.skipped.username += 1; continue; }
      if (!password || password.length > 500) { result.skipped.password += 1; continue; }
      const existing = entries.find(entry => entry.site === site && entry.username === username);
      if (existing) {
        let known = false;
        try { known = plain(existing) === password; } catch { known = false; }
        if (known) { result.same += 1; continue; }
        delete existing.wrapped;
        Object.assign(existing, { secret: seal(password), updatedAt: at });
        result.updated += 1;
      } else if (entries.length >= MAX_ENTRIES) result.skipped.full += 1;
      else {
        entries.push({ id: randomUUID(), site, username, secret: seal(password), createdAt: at, updatedAt: at, usedAt: null });
        result.added += 1;
      }
    }
    if (result.added || result.updated) persist();
    return result;
  }
  function remove(id) {
    mustBeOpen();
    const entry = find(id);
    entries = entries.filter(item => item !== entry);
    persist();
    return true;
  }
  // 全部删除: every saved password goes; a vault password stays as it is.
  function clear() {
    mustBeOpen();
    entries = [];
    persist();
    return list();
  }
  // 显示密码 in Settings: the open vault's passwords by entry, only when the user asks to see them.
  function reveal() {
    mustBeOpen();
    return Object.fromEntries(entries.map(entry => [entry.id, plain(entry)]));
  }
  // Whether the Dayjob browser can fill saved passwords now: always, unless some are from before 0.20.0 and the
  // vault has not been opened since.
  const fillable = () => !entries.some(waiting);
  // The sign-ins for a page's host, the most recently used first.
  function forHost(host) {
    const name = String(host || '').toLowerCase();
    return entries.filter(entry => covers(entry.site, name))
      .sort((a, b) => (b.usedAt || '').localeCompare(a.usedAt || '') || b.updatedAt.localeCompare(a.updatedAt)).map(shown);
  }
  // Only for filling a login form in the Dayjob browser, locked or not.
  function password(id) {
    const entry = find(id);
    if (waiting(entry)) fail('Open the password vault once with its password, so it can fill this one.');
    return plain(entry);
  }
  // Whether this password is already saved for the host, so it is not offered again. One from before 0.20.0 that
  // the vault password has not opened yet counts by its user name.
  function knows(host, username, typed) {
    const same = entries.filter(entry => covers(entry.site, host) && entry.username === username);
    return same.some(entry => { if (waiting(entry)) return true; try { return plain(entry) === typed; } catch { return false; } });
  }

  // The key of the vault password, if this is it.
  async function check(password) {
    if (clock() < waitUntil) fail(`Too many wrong tries. Try again in ${Math.ceil((waitUntil - clock()) / 1000)} seconds.`);
    const candidate = typeof password === 'string' && password.length <= 64 ? await derive(password, Buffer.from(lock.salt, 'base64')) : null;
    let right = false;
    try { right = Boolean(candidate) && unwrap(candidate, lock.check) === CHECK; } catch { right = false; }
    if (!right) {
      misses += 1;
      if (misses >= TRIES) { misses = 0; waitUntil = clock() + WAIT_MS; }
      fail('That is not the vault password.');
    }
    misses = 0;
    return candidate;
  }
  async function unlock(password) {
    if (lock && !key) {
      key = await check(password);
      release(key);
    }
    return list();
  }
  function close() {
    key = null;
    return list();
  }
  // Sets the vault password, or changes it (with the current one). The saved passwords stay sealed by the system.
  async function setLock({ current, next } = {}) {
    if (typeof next !== 'string' || !LOCK_RULE.test(next)) fail('The vault password must be 6 to 32 letters or digits.');
    if (!available()) fail('This computer cannot encrypt saved passwords, so none can be saved.');
    if (lock) release(await check(current));
    const salt = randomBytes(16);
    const newKey = await derive(next, salt);
    lock = { salt: salt.toString('base64'), check: wrap(newKey, CHECK) };
    key = newKey;
    persist();
    return list();
  }
  // Takes the vault password off (with it): the saved passwords stay, sealed by the system.
  async function removeLock(current) {
    if (!lock) return list();
    release(await check(current));
    lock = null;
    key = null;
    persist();
    return list();
  }
  // A forgotten vault password cannot be got back, and nothing sealed with it can be opened: this empties the
  // vault and takes the password off.
  function reset() {
    entries = [];
    lock = null;
    key = null;
    persist();
    return list();
  }
  function used(id) {
    const entry = entries.find(item => item.id === id);
    if (!entry) return;
    entry.usedAt = now().toISOString();
    persist();
  }

  return { available, locked, fillable, list, save, importMany, remove, clear, reveal, forHost, password, knows, used, unlock, close, setLock, removeLock, reset };
}

module.exports = { createVault, siteOf, parseCsv, readPasswordCsv, VaultError, LOCK_RULE };
