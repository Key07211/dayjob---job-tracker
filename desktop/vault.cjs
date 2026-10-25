const fs = require('node:fs');
const { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } = require('node:crypto');

// 密码保管: sign-ins for job sites, kept in one file on this computer with each
// password encrypted by the operating system (on Windows, DPAPI, tied to the
// Windows account). A password only ever goes into the login form of its own
// site in the Dayjob browser: never back to the interface, never to the local
// server or its API, and never to Claude.
//
// The vault can also have its own password (开箱密码). Then each saved password
// is first sealed with a key made from it (scrypt, AES-256-GCM) and only then by
// the system, so the file is no use without it, even to a program running as
// the same Windows user. The vault opens with that password once per start of
// Dayjob and closes again when Dayjob quits, the computer locks or sleeps, or
// the user closes it. Neither password is ever stored.
const MAX_ENTRIES = 200;
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
  // The vault password's salt and a check value sealed with its key; with it set, every entry is wrapped.
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
  const system = text => {
    if (!available()) fail('This computer cannot encrypt saved passwords, so none can be saved.');
    return safeStorage.encryptString(text).toString('base64');
  };
  const seal = password => system(lock ? wrap(key, password) : password);
  // The saved password itself, with the key it is wrapped in (the open vault's, or one just checked).
  const plain = (entry, withKey = key) => {
    const opened = safeStorage.decryptString(Buffer.from(entry.secret, 'base64'));
    return entry.wrapped ? unwrap(withKey, opened) : opened;
  };
  const shown = ({ id, site, username, createdAt, updatedAt, usedAt }) => ({ id, site, username, createdAt, updatedAt, usedAt: usedAt || null });
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
      Object.assign(existing, { site, username, updatedAt: at }, password ? { secret: seal(password), wrapped: Boolean(lock) } : {});
      persist();
      return shown(existing);
    }
    if (!password) fail('Enter the password.');
    if (entries.length >= MAX_ENTRIES) fail(`Up to ${MAX_ENTRIES} passwords can be saved.`);
    const entry = { id: randomUUID(), site, username, secret: seal(password), wrapped: Boolean(lock), createdAt: at, updatedAt: at, usedAt: null };
    entries.push(entry);
    persist();
    return shown(entry);
  }
  function remove(id) {
    mustBeOpen();
    const entry = find(id);
    entries = entries.filter(item => item !== entry);
    persist();
    return true;
  }
  // The sign-ins for a page's host, the most recently used first.
  function forHost(host) {
    const name = String(host || '').toLowerCase();
    return entries.filter(entry => covers(entry.site, name))
      .sort((a, b) => (b.usedAt || '').localeCompare(a.usedAt || '') || b.updatedAt.localeCompare(a.updatedAt)).map(shown);
  }
  // Only for filling a login form in the Dayjob browser.
  function password(id) {
    mustBeOpen();
    return plain(find(id));
  }
  // Whether this password is already saved for the host, so it is not offered again. While the vault is closed,
  // a saved sign-in for the same user name counts.
  function knows(host, username, typed) {
    const same = entries.filter(entry => covers(entry.site, host) && entry.username === username);
    if (locked()) return same.length > 0;
    return same.some(entry => { try { return plain(entry) === typed; } catch { return false; } });
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
    if (lock && !key) key = await check(password);
    return list();
  }
  function close() {
    key = null;
    return list();
  }
  // Sets the vault password, or changes it (with the current one): every saved password is opened with the old
  // key and sealed again with the new one.
  async function setLock({ current, next } = {}) {
    if (typeof next !== 'string' || !LOCK_RULE.test(next)) fail('The vault password must be 6 to 32 letters or digits.');
    if (!available()) fail('This computer cannot encrypt saved passwords, so none can be saved.');
    const oldKey = lock ? await check(current) : null;
    const opened = entries.map(entry => plain(entry, oldKey));
    const salt = randomBytes(16);
    const newKey = await derive(next, salt);
    lock = { salt: salt.toString('base64'), check: wrap(newKey, CHECK) };
    key = newKey;
    entries.forEach((entry, index) => Object.assign(entry, { secret: system(wrap(newKey, opened[index])), wrapped: true }));
    persist();
    return list();
  }
  // Takes the vault password off (with it): the saved passwords stay, sealed by the system only.
  async function removeLock(current) {
    if (!lock) return list();
    const oldKey = await check(current);
    const opened = entries.map(entry => plain(entry, oldKey));
    entries.forEach((entry, index) => { entry.secret = system(opened[index]); delete entry.wrapped; });
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

  return { available, locked, list, save, remove, forHost, password, knows, used, unlock, close, setLock, removeLock, reset };
}

module.exports = { createVault, siteOf, VaultError, LOCK_RULE };
