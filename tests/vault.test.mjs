import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vaultModule from '../desktop/vault.cjs';
import loginModule from '../desktop/login.cjs';

const { createVault, siteOf, parseCsv, readPasswordCsv } = vaultModule;
const { loginScript } = loginModule;

// Stands in for Electron's safeStorage: the stored text must not be the password.
function fakeSafeStorage(available = true) {
  const flip = text => [...text].map(letter => String.fromCharCode(letter.charCodeAt(0) ^ 0x5a)).join('');
  return {
    isEncryptionAvailable: () => available,
    encryptString: text => Buffer.from(`sealed:${flip(text)}`, 'utf8'),
    decryptString: buffer => flip(buffer.toString('utf8').replace(/^sealed:/, '')),
  };
}
const vaultFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dayjob-vault-')), 'vault.json');
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 25, 8, 0, clock++));

test('a site is kept as its host name, from a link, a host or a domain', () => {
  assert.equal(siteOf('https://www.linkedin.com/jobs/view/1'), 'linkedin.com');
  assert.equal(siteOf('  Acme.WD5.myworkdayjobs.com '), 'acme.wd5.myworkdayjobs.com');
  assert.equal(siteOf('http://localhost:4377/login'), 'localhost');
  for (const bad of ['', 'not a site', 'file:///C:/secret.txt', 'javascript:alert(1)', 'ftp://example.com', '.com']) assert.equal(siteOf(bad), null, bad);
});

test('passwords are sealed on disk, matched to their site and never listed', () => {
  const file = vaultFile();
  const vault = createVault({ file, safeStorage: fakeSafeStorage(), now });
  const workday = vault.save({ site: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/login', username: ' yuan@example.com ', password: 'Hunter2!pass' });
  const linkedin = vault.save({ site: 'linkedin.com', username: 'yuan', password: 'linked-secret' });
  assert.deepEqual(Object.keys(workday).sort(), ['createdAt', 'id', 'site', 'updatedAt', 'usedAt', 'username']);
  assert.equal(workday.username, 'yuan@example.com');

  const stored = fs.readFileSync(file, 'utf8');
  assert.ok(!stored.includes('Hunter2!pass') && !stored.includes('linked-secret'), 'no password is written as plain text');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const { available, entries } = vault.list();
  assert.equal(available, true);
  assert.deepEqual(entries.map(entry => entry.site), ['acme.wd5.myworkdayjobs.com', 'linkedin.com']);
  assert.ok(!JSON.stringify(entries).includes('secret') && !JSON.stringify(entries).includes('Hunter2'), 'the list has no passwords');

  // A domain covers its subdomains, never a look-alike.
  assert.deepEqual(vault.forHost('www.linkedin.com').map(entry => entry.id), [linkedin.id]);
  assert.deepEqual(vault.forHost('linkedin.com.evil.example').map(entry => entry.id), []);
  assert.deepEqual(vault.forHost('evillinkedin.com'), []);
  assert.deepEqual(vault.forHost('acme.wd5.myworkdayjobs.com').map(entry => entry.id), [workday.id]);
  assert.deepEqual(vault.forHost('other.wd5.myworkdayjobs.com'), []);
  assert.equal(vault.password(workday.id), 'Hunter2!pass');

  assert.equal(vault.knows('www.linkedin.com', 'yuan', 'linked-secret'), true);
  assert.equal(vault.knows('www.linkedin.com', 'yuan', 'a new password'), false);
  assert.equal(vault.knows('www.linkedin.com', 'someone else', 'linked-secret'), false);

  // It is all still there after a restart.
  const again = createVault({ file, safeStorage: fakeSafeStorage(), now });
  assert.equal(again.list().entries.length, 2);
  assert.equal(again.password(linkedin.id), 'linked-secret');
});

test('saving again changes a sign-in, and an empty password keeps the saved one', () => {
  const vault = createVault({ file: vaultFile(), safeStorage: fakeSafeStorage(), now });
  const first = vault.save({ site: 'greenhouse.io', username: 'yuan', password: 'one' });
  const same = vault.save({ site: 'https://boards.greenhouse.io', username: 'yuan', password: 'two' });
  assert.notEqual(same.id, first.id, 'a different host is a different sign-in');
  const updated = vault.save({ site: 'greenhouse.io', username: 'yuan', password: 'three' });
  assert.equal(updated.id, first.id, 'the same site and user name updates the saved one');
  assert.equal(vault.password(first.id), 'three');

  const renamed = vault.save({ id: first.id, site: 'greenhouse.io', username: 'yuan.li', password: '' });
  assert.equal(renamed.username, 'yuan.li');
  assert.equal(vault.password(first.id), 'three', 'an empty password on edit keeps it');

  vault.used(first.id);
  assert.ok(vault.forHost('greenhouse.io')[0].usedAt);
  assert.throws(() => vault.save({ id: same.id, site: 'greenhouse.io', username: 'yuan.li', password: '' }), /already has a saved password/);
  assert.throws(() => vault.save({ site: 'greenhouse.io', username: 'new', password: '' }), /Enter the password/);
  assert.throws(() => vault.save({ site: 'not a site', username: 'a', password: 'b' }), /web address/);
  assert.throws(() => vault.save({ site: 'greenhouse.io', username: '', password: 'b' }), /user name/);
  assert.throws(() => vault.save({ site: 'greenhouse.io', username: 'a', password: 'x'.repeat(501) }), /500/);

  assert.equal(vault.remove(first.id), true);
  assert.deepEqual(vault.list().entries.map(entry => entry.id), [same.id]);
  assert.throws(() => vault.remove(first.id), /No such/);
});

test('nothing is saved when the computer cannot encrypt it', () => {
  const file = vaultFile();
  const vault = createVault({ file, safeStorage: fakeSafeStorage(false), now });
  assert.equal(vault.list().available, false);
  assert.throws(() => vault.save({ site: 'linkedin.com', username: 'yuan', password: 'secret' }), /cannot encrypt/);
  assert.equal(fs.existsSync(file), false);
});

test('the login script for the page is plain script text with its arguments quoted', () => {
  const script = loginScript('fill', { username: 'a"b', password: '</script>\'x' });
  assert.match(script, /\.fill\(\{"username":"a\\"b","password":"<\/script>'x"\}\)$/);
  assert.doesNotThrow(() => new Function(script));
  assert.match(loginScript('probe'), /\.probe\(\)$/);
  assert.match(loginScript('submit'), /\.submit\(\)$/);
  assert.doesNotThrow(() => new Function(loginScript('fillUser', { username: 'two@example.com' })));
});

test('a CSV file keeps quoted commas, quotes and line breaks in their fields', () => {
  assert.deepEqual(parseCsv('﻿name,url\r\n"a, b","say ""hi"""\r\n\r\n"two\nlines",x\n,\nlast,row'), [
    ['name', 'url'], ['a, b', 'say "hi"'], ['two\nlines', 'x'], ['last', 'row']]);
  assert.deepEqual(parseCsv(''), []);
});

test('password exports from Edge, Chrome and Firefox are read by their column names', () => {
  const edge = readPasswordCsv('name,url,username,password,note\r\nacme,https://acme.example.com/login,ana@example.com,"p,w",\r\n');
  assert.deepEqual(edge, [{ url: 'https://acme.example.com/login', username: 'ana@example.com', password: 'p,w' }]);
  const firefox = readPasswordCsv('"url","username","password","httpRealm","formActionOrigin","guid"\n"https://jobs.example.org","ana","fx-pass","","https://jobs.example.org",""');
  assert.deepEqual(firefox, [{ url: 'https://jobs.example.org', username: 'ana', password: 'fx-pass' }]);
  for (const bad of ['', 'a,b,c\n1,2,3', 'url,username\nhttps://x.example.com,ana']) assert.throws(() => readPasswordCsv(bad), /not a password export/, bad);
});

test('an import adds new sign-ins, updates changed ones, leaves the same ones and counts what it skipped', async () => {
  const file = vaultFile();
  const vault = createVault({ file, safeStorage: fakeSafeStorage(), now });
  const kept = vault.save({ site: 'linkedin.com', username: 'yuan', password: 'linked-secret' });
  const changed = vault.save({ site: 'acme.wd5.myworkdayjobs.com', username: 'yuan@example.com', password: 'old-pass' });
  const rows = readPasswordCsv(['name,url,username,password,note',
    'linkedin,https://www.linkedin.com/login,yuan,linked-secret,',
    'workday,https://acme.wd5.myworkdayjobs.com/en-US/careers/login,yuan@example.com,new-pass,',
    'greenhouse,https://boards.greenhouse.io/acme,ana@example.com,gh-pass,',
    'app,android://key@com.example.app/,ana,app-pass,',
    'nouser,https://nouser.example.com,,lonely-pass,',
    'empty,https://empty.example.com,ana,,',
    `long,https://long.example.com,ana,${'x'.repeat(501)},`].join('\r\n'));
  const result = vault.importMany(rows);
  assert.deepEqual(result, { added: 1, updated: 1, same: 1, skipped: { site: 1, username: 1, password: 2, full: 0 } });
  assert.ok(!/linked-secret|new-pass|gh-pass|app-pass|lonely-pass/.test(JSON.stringify(result) + JSON.stringify(vault.list()) + fs.readFileSync(file, 'utf8')),
    'only counts come back, and the file keeps the passwords sealed');
  assert.equal(vault.password(kept.id), 'linked-secret');
  assert.equal(vault.password(changed.id), 'new-pass');
  const greenhouse = vault.forHost('boards.greenhouse.io')[0];
  assert.equal(greenhouse.username, 'ana@example.com');
  assert.equal(vault.password(greenhouse.id), 'gh-pass');
  assert.deepEqual(vault.importMany(rows), { added: 0, updated: 0, same: 3, skipped: { site: 1, username: 1, password: 2, full: 0 } }, 'importing again changes nothing');

  // With a vault password, a closed vault takes nothing in, and an open one seals the new ones with it too.
  await vault.setLock({ next: 'Lock1234' });
  vault.close();
  assert.throws(() => vault.importMany(rows), /Open the password vault/);
  await vault.unlock('Lock1234');
  vault.importMany([{ url: 'https://lever.co', username: 'ana', password: 'lever-pass' }]);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(stored.entries.every(entry => entry.wrapped));
  assert.equal(vault.password(vault.forHost('jobs.lever.co')[0].id), 'lever-pass');
});

test('an import stops adding at the limit and says how many did not fit', () => {
  const vault = createVault({ file: vaultFile(), safeStorage: fakeSafeStorage(), now });
  const rows = Array.from({ length: 2003 }, (_, index) => ({ url: `https://site${index}.example.com`, username: 'ana', password: `pass-${index}` }));
  const result = vault.importMany(rows);
  assert.deepEqual([result.added, result.skipped.full, vault.list().count], [2000, 3, 2000]);
  assert.throws(() => vault.save({ site: 'one-more.example.com', username: 'ana', password: 'x' }), /Up to 2000 passwords/);
});

test('a vault password seals every password again, and the locked vault lists and fills nothing', async () => {
  const file = vaultFile();
  const safeStorage = fakeSafeStorage();
  let time = 0;
  const clock = () => time;
  const vault = createVault({ file, safeStorage, now, clock });
  const linkedin = vault.save({ site: 'linkedin.com', username: 'yuan', password: 'linked-secret' });
  const workday = vault.save({ site: 'acme.wd5.myworkdayjobs.com', username: 'yuan@example.com', password: 'Hunter2!pass' });
  for (const bad of ['abc12', 'x'.repeat(33), 'with space1', 'símbolo123', 'pass-word1']) await assert.rejects(vault.setLock({ next: bad }), /6 to 32 letters or digits/, bad);

  assert.deepEqual(await vault.setLock({ next: 'Lock1234' }).then(list => [list.lock, list.locked, list.entries.length]), [true, false, 2]);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!JSON.stringify(stored).includes('Lock1234'), 'the vault password is not stored');
  assert.ok(stored.entries.every(entry => entry.wrapped && !['linked-secret', 'Hunter2!pass'].includes(safeStorage.decryptString(Buffer.from(entry.secret, 'base64')))),
    'under the system layer each password is sealed again with the vault password');
  assert.equal(vault.password(linkedin.id), 'linked-secret', 'open, it fills as before');

  // Locked: nothing is listed, filled or changed; a typed password for a saved user name is not offered again.
  assert.deepEqual([vault.close().locked, vault.list().entries, vault.list().count], [true, [], 2]);
  assert.throws(() => vault.password(linkedin.id), /Open the password vault/);
  assert.throws(() => vault.save({ site: 'greenhouse.io', username: 'a', password: 'b' }), /Open the password vault/);
  assert.throws(() => vault.remove(linkedin.id), /Open the password vault/);
  assert.equal(vault.knows('www.linkedin.com', 'yuan', 'anything'), true);
  assert.equal(vault.knows('www.linkedin.com', 'someone else', 'anything'), false);

  // It starts locked after a restart, and opens only with its password; too many wrong tries make it wait.
  const again = createVault({ file, safeStorage, now, clock });
  assert.equal(again.locked(), true);
  await assert.rejects(again.unlock('Wrong1234'), /not the vault password/);
  for (let i = 0; i < 4; i += 1) await assert.rejects(again.unlock('Wrong1234'), /not the vault password/);
  await assert.rejects(again.unlock('Lock1234'), /Too many wrong tries\. Try again in 30 seconds/);
  time += 30000;
  assert.equal((await again.unlock('Lock1234')).locked, false);
  assert.equal(again.password(workday.id), 'Hunter2!pass');
  const added = again.save({ site: 'greenhouse.io', username: 'yuan', password: 'green-secret' });

  // Changing it needs the current one; the passwords carry over.
  await assert.rejects(again.setLock({ current: 'Wrong1234', next: 'NewLock99' }), /not the vault password/);
  await again.setLock({ current: 'Lock1234', next: 'NewLock99' });
  const third = createVault({ file, safeStorage, now, clock });
  await assert.rejects(third.unlock('Lock1234'), /not the vault password/);
  await third.unlock('NewLock99');
  assert.deepEqual([third.password(linkedin.id), third.password(added.id)], ['linked-secret', 'green-secret']);

  // Taking it off keeps the passwords under the system's encryption only.
  await assert.rejects(third.removeLock('Lock1234'), /not the vault password/);
  assert.equal((await third.removeLock('NewLock99')).lock, false);
  const plain = createVault({ file, safeStorage, now, clock });
  assert.deepEqual([plain.locked(), plain.password(workday.id)], [false, 'Hunter2!pass']);
  assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).lock);
});

test('a forgotten vault password empties the vault', async () => {
  const file = vaultFile();
  const vault = createVault({ file, safeStorage: fakeSafeStorage(), now });
  vault.save({ site: 'linkedin.com', username: 'yuan', password: 'linked-secret' });
  await vault.setLock({ next: 'Lock1234' });
  vault.close();
  assert.deepEqual(vault.reset(), { available: true, lock: false, locked: false, count: 0, entries: [] });
  const after = createVault({ file, safeStorage: fakeSafeStorage(), now });
  assert.deepEqual([after.locked(), after.list().count], [false, 0]);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
});
