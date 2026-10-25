const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

// 密码保管: sign-ins for job sites, kept in one file on this computer with each
// password encrypted by the operating system (on Windows, DPAPI, tied to the
// Windows account). A password only ever goes into the login form of its own
// site in the Dayjob browser: never back to the interface, never to the local
// server or its API, and never to Claude.
const MAX_ENTRIES = 200;

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

function createVault({ file, safeStorage, now = () => new Date() }) {
  let entries = [];
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    entries = (Array.isArray(stored.entries) ? stored.entries : []).filter(entry => entry && typeof entry.id === 'string' && siteOf(entry.site) && typeof entry.secret === 'string');
  } catch { /* none saved yet */ }

  function persist() {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }, null, 1), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  const available = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  const seal = password => {
    if (!available()) fail('This computer cannot encrypt saved passwords, so none can be saved.');
    return safeStorage.encryptString(password).toString('base64');
  };
  const shown = ({ id, site, username, createdAt, updatedAt, usedAt }) => ({ id, site, username, createdAt, updatedAt, usedAt: usedAt || null });
  const find = id => entries.find(entry => entry.id === id) || fail('No such saved password.');

  function list() {
    return { available: available(), entries: entries.map(shown).sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username)) };
  }
  // Adds a sign-in, or changes one; an empty password keeps the saved one.
  function save(input) {
    const site = siteOf(input?.site) || fail('Enter the site as a web address, such as myworkdayjobs.com.');
    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    if (!username || username.length > 200) fail('Enter the user name or email, up to 200 characters.');
    const password = typeof input?.password === 'string' ? input.password : '';
    if (password.length > 500) fail('The password must be 500 characters or fewer.');
    const at = now().toISOString();
    const existing = input.id ? find(input.id) : entries.find(entry => entry.site === site && entry.username === username);
    if (existing) {
      if (entries.some(entry => entry !== existing && entry.site === site && entry.username === username)) fail('That site already has a saved password for this user name.');
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
  function remove(id) {
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
    return safeStorage.decryptString(Buffer.from(find(id).secret, 'base64'));
  }
  // Whether this password is already saved for the host, so it is not offered again.
  function knows(host, username, typed) {
    return entries.some(entry => covers(entry.site, host) && entry.username === username && (() => { try { return password(entry.id) === typed; } catch { return false; } })());
  }
  function used(id) {
    const entry = entries.find(item => item.id === id);
    if (!entry) return;
    entry.usedAt = now().toISOString();
    persist();
  }

  return { available, list, save, remove, forHost, password, knows, used };
}

module.exports = { createVault, siteOf, VaultError };
