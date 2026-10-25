import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vaultModule from '../desktop/vault.cjs';
import loginModule from '../desktop/login.cjs';

const { createVault, siteOf } = vaultModule;
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
});
