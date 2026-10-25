import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock3, Download, Eye, EyeOff, FileUp, FolderOpen, Globe, KeyRound, LampDesk, Link2, LoaderCircle, Lock, LockOpen, Monitor, Pencil, Plus, Power, RefreshCw, Search,
  ShieldAlert, Sun, Trash2, X } from 'lucide-react';
import { api } from '../api.js';
import { LanguageSwitch, useI18n } from '../i18n.jsx';
import { serverText } from './server-text.js';
import { SoundSettings } from './groove/SoundSettings.jsx';
import { cue } from './groove/sound.js';
import { leaveThen, pop, shake, unfold } from './groove/fx.js';
import { formatTime } from './format.js';
import { SavedLabel, useSaved } from './groove/Fx.jsx';
import { releaseThemeHold, setThemeChoice, setThemeHours, useThemeSettings } from './theme.js';
import { ViewDate } from './ViewDate.jsx';
import { updateProblem } from './UpdateButton.jsx';
import { ListenWave } from './groove/ListenWave.jsx';
import { TimeField } from './groove/Picker.jsx';

const desktop = typeof window !== 'undefined' ? window.dayjobDesktop : undefined;
const CLAUDE_STATES = { ready: ['已连接', 'Connected'], missing: ['未连接', 'Not connected'], conflict: ['已有同名连接（未改动）', 'Another Dayjob connection exists (left as is)'],
  error: ['连接异常', 'Connection problem'], unavailable: ['没有找到 Claude Code 或 Claude Desktop', 'Claude Code or Claude Desktop not found'] };

function ClaudeConnection() {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const icon = useRef(null);
  useEffect(() => { desktop?.getClaudeStatus().then(setStatus).catch(() => {}); }, []);
  if (!desktop) {
    return (
      <section className="card-section">
        <h2><Link2 size={18} />{t('连接 Claude（MCP）', 'Connect Claude (MCP)')}</h2>
        <p className="hint">{t('在桌面版里可以一键连接。源码运行时，在终端执行：', 'The desktop app connects in one click. When running from source, run this in a terminal:')}</p>
        <pre className="code">{`claude mcp add dayjob -s user -e DAYJOB_URL=http://127.0.0.1:4318 -- node <${t('Dayjob 文件夹', 'Dayjob folder')}>/integrations/mcp-server.mjs`}</pre>
      </section>
    );
  }
  // Connected answers with a ✓ that pops; anything else shakes the button that was pressed.
  async function run(work, button) {
    setBusy(true);
    setError('');
    try {
      const next = await work();
      setStatus(next);
      if (next?.state === 'ready') { cue('success'); requestAnimationFrame(() => pop(icon.current, 1.35)); } else shake(button);
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return (
    <section className="card-section">
      <h2><Link2 size={18} />{t('连接 Claude（MCP）', 'Connect Claude (MCP)')}</h2>
      <p className="hint">{t('连接后，在 Claude Code 或 Claude Desktop 里可以说“看看今天高匹配的岗位”“对照我的简历分析这个岗位”“根据 Gmail 更新我的投递状态”。Claude 需要 Dayjob 保持运行。',
        'Once connected, ask Claude Code or Claude Desktop things like “show today\'s strong matches”, “analyse this job against my resume” or “update my applications from Gmail”. Dayjob needs to be running.')}</p>
      <p className={`status-line ${status?.state === 'ready' ? 'ok' : 'off'}`}>
        {status?.state === 'ready' ? <CheckCircle2 size={15} ref={icon} /> : null}
        {status ? t(...(CLAUDE_STATES[status.state] || [status.state, status.state])) : t('检查中…', 'Checking…')}
        {status?.clients?.filter(client => client.state !== 'unavailable').map(client => <span key={client.id} className="muted"> · {client.label}</span>)}
      </p>
      {status?.message && status.state !== 'ready' ? <p className="hint">{serverText(status.message)}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions">
        <button className="button" data-fx="refresh" onClick={event => run(() => desktop.checkClaude(), event.currentTarget)} disabled={busy}><RefreshCw size={15} />{t('重新检查', 'Check again')}</button>
        {status?.state !== 'ready' ? <button className="button primary" onClick={event => run(() => desktop.connectClaude(), event.currentTarget)} disabled={busy}>
          {busy ? <span className="dots" aria-hidden="true"><i /><i /><i /></span> : <Link2 size={15} />}{t('连接到 Claude', 'Connect to Claude')}</button> : null}
      </div>
      <p className="hint">{t('会写入 Claude Code 的 ~/.claude.json 和 Claude Desktop 的配置文件（改之前自动备份）。Claude Desktop 需要重启后才会看到新工具。',
        'Writes Claude Code\'s ~/.claude.json and Claude Desktop\'s config file, backing each up first. Restart Claude Desktop to see the new tools.')}</p>
    </section>
  );
}

function BrowserData() {
  const { t } = useI18n();
  const [state, setState] = useState('');
  if (!desktop?.browser) return null;
  async function clear() {
    if (!window.confirm(t('清除 Dayjob 浏览器里所有网站的登录状态、Cookie 和缓存？打开的标签页会关闭。', 'Clear every sign-in, cookie and cache in the Dayjob browser? Open tabs are closed.'))) return;
    setState('busy');
    try { await desktop.browser.clearData(); setState('done'); } catch { setState('error'); }
  }
  return (
    <section className="card-section">
      <h2><Globe size={18} />{t('Dayjob 浏览器', 'Dayjob browser')}</h2>
      <p className="hint">{t('浏览器里的登录状态和 Cookie 只保存在这台电脑的 Dayjob 数据里，和 Chrome、Edge 分开。连接 Claude 后，Claude 能在里面打开和阅读网页、填写表单；提交或发送之前会先请你在 Dayjob 里确认，密码和文件上传不会交给 Claude。浏览器工具栏里可以随时关掉“允许 Claude 使用”。',
        'Sign-ins and cookies in the browser stay in Dayjob\'s data on this computer, separate from Chrome and Edge. With Claude connected, Claude can open and read pages there and fill in forms; before anything is submitted or sent it asks you in Dayjob, and it never gets passwords or file uploads. Turn off “Let Claude use it” in the browser toolbar at any time.')}</p>
      <div className="form-actions">
        <button className="button" data-fx="sweep" onClick={clear} disabled={state === 'busy'}><Trash2 size={15} />{t('清除登录状态和缓存', 'Clear sign-ins and cache')}</button>
      </div>
      {state === 'done' ? <p className="notice">{t('已清除。', 'Cleared.')}</p> : null}
      {state === 'error' ? <p className="notice error">{t('没能清除，请重试。', 'Could not clear it. Try again.')}</p> : null}
    </section>
  );
}

// The desktop side's errors arrive wrapped by Electron.
const bridgeText = failure => serverText(String(failure?.message || '').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''));

function VaultForm({ entry, onCancel, onSaved }) {
  const { t } = useI18n();
  const form = useRef(null);
  const [site, setSite] = useState(entry?.site || '');
  const [username, setUsername] = useState(entry?.username || '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { unfold(form.current); }, []);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = await desktop.vault.save({ id: entry?.id, site, username, password });
      setPassword('');
      onSaved(saved);
    } catch (failure) {
      setError(bridgeText(failure));
      shake(form.current);
    } finally { setBusy(false); }
  }
  return (
    <form className="vault-form" ref={form} onSubmit={submit} autoComplete="off">
      <div className="form-grid">
        <label>{t('网站', 'Site')}<input value={site} onChange={event => setSite(event.target.value)} placeholder="myworkdayjobs.com" maxLength={300} required /></label>
        <label>{t('用户名或邮箱', 'User name or email')}<input value={username} onChange={event => setUsername(event.target.value)} maxLength={200} required autoComplete="off" /></label>
        <label>{t('密码', 'Password')}
          <span className="vault-secret">
            <input type={show ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} maxLength={500} required={!entry}
              autoComplete="new-password" placeholder={entry ? t('不改就留空', 'Leave empty to keep it') : undefined} />
            <button type="button" className="icon-button" title={show ? t('隐藏', 'Hide') : t('显示正在输入的密码', 'Show what you type')} onClick={() => setShow(value => !value)}>{show ? <EyeOff size={15} /> : <Eye size={15} />}</button>
          </span>
        </label>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>{t('取消', 'Cancel')}</button>
        <button type="submit" className="button primary" disabled={busy}>{t('保存', 'Save')}</button>
      </div>
    </form>
  );
}

// 密码保管: the list shows sites and user names; a password goes in and never comes back out.
// The vault's own password (开箱密码): 6 to 32 letters or digits.
const VAULT_PASSWORD = /^[A-Za-z0-9]{6,32}$/;

// The closed vault: its password opens it. A forgotten one cannot be got back, so the only way on is to empty it.
function VaultUnlock({ count, onChanged }) {
  const { t } = useI18n();
  const form = useRef(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { unfold(form.current); }, []);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try { onChanged(await desktop.vault.unlock(password), 'opened'); }
    catch (failure) { setError(bridgeText(failure)); setPassword(''); shake(form.current); }
    finally { setBusy(false); }
  }
  async function reset() {
    if (!window.confirm(t(`开箱密码忘了就没法找回。清空密码箱会删掉里面的 ${count} 个密码，并取消开箱密码。确定清空吗？`,
      `A forgotten vault password cannot be recovered. Emptying the vault deletes its ${count} saved ${count === 1 ? 'password' : 'passwords'} and removes the vault password. Empty it?`))) return;
    try { onChanged(await desktop.vault.reset(), 'reset'); } catch (failure) { setError(bridgeText(failure)); }
  }
  return (
    <form className="vault-form vault-unlock" ref={form} onSubmit={submit} autoComplete="off">
      <p><Lock size={15} />{t(`密码箱已锁上，里面有 ${count} 个密码。`, `The vault is locked; it holds ${count} ${count === 1 ? 'password' : 'passwords'}.`)}</p>
      <div className="vault-secret">
        <input type="password" value={password} onChange={event => setPassword(event.target.value)} maxLength={32} autoComplete="off" placeholder={t('开箱密码', 'Vault password')} aria-label={t('开箱密码', 'Vault password')} required />
        <button type="submit" className="button primary" disabled={busy}><LockOpen size={15} />{t('打开', 'Open')}</button>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      <button type="button" className="link" onClick={reset}>{t('忘了开箱密码？', 'Forgot the vault password?')}</button>
    </form>
  );
}

// Setting, changing or taking off the vault password.
function LockForm({ mode, onCancel, onDone }) {
  const { t } = useI18n();
  const form = useRef(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { unfold(form.current); }, []);
  const wrong = message => { setError(message); shake(form.current); };
  async function submit(event) {
    event.preventDefault();
    setError('');
    if (mode !== 'remove' && !VAULT_PASSWORD.test(next)) return wrong(t('开箱密码要 6–32 位，只能用字母或数字。', 'The vault password must be 6 to 32 letters or digits.'));
    if (mode !== 'remove' && next !== again) return wrong(t('两次输入的开箱密码不一样。', 'The two new vault passwords are not the same.'));
    setBusy(true);
    try { onDone(mode === 'remove' ? await desktop.vault.removeLock(current) : await desktop.vault.setLock({ current, next }), mode); }
    catch (failure) { wrong(bridgeText(failure)); }
    finally { setBusy(false); }
  }
  const box = (label, value, set, complete) => (
    <label>{label}<input type="password" value={value} onChange={event => set(event.target.value)} maxLength={32} autoComplete={complete} required /></label>
  );
  return (
    <form className="vault-form" ref={form} onSubmit={submit} autoComplete="off">
      {mode === 'set' ? <p className="hint">{t('设好后，每次打开 Dayjob 都要先输入开箱密码，才能查看密码和自动填写；电脑锁屏或睡眠时，密码箱也会锁上。开箱密码忘了没法找回，只能清空密码箱重来。',
        'Once set, the vault must be opened with it each time Dayjob starts before passwords are listed or filled in, and it locks again when the computer locks or sleeps. A forgotten vault password cannot be recovered; the vault can only be emptied.')}</p> : null}
      <div className="form-grid">
        {mode !== 'set' ? box(t('现在的开箱密码', 'Current vault password'), current, setCurrent, 'current-password') : null}
        {mode !== 'remove' ? box(t('新的开箱密码（6–32 位字母或数字）', 'New vault password (6–32 letters or digits)'), next, setNext, 'new-password') : null}
        {mode !== 'remove' ? box(t('再输入一次', 'Type it again'), again, setAgain, 'new-password') : null}
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>{t('取消', 'Cancel')}</button>
        <button type="submit" className="button primary" disabled={busy}>{mode === 'remove' ? t('取消开箱密码', 'Remove the vault password') : t('保存', 'Save')}</button>
      </div>
    </form>
  );
}

// What an import of a browser's password export did. The file holds every password in plain text, so it is
// offered to the Recycle Bin (where it can still be restored from).
function ImportResult({ result, onClose }) {
  const { t } = useI18n();
  const box = useRef(null);
  const [trash, setTrash] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { unfold(box.current); }, []);
  const { added, updated, same, skipped } = result;
  const left = skipped.site + skipped.username + skipped.password + skipped.full;
  const reasons = [
    [skipped.site, `${skipped.site} 条不是网页地址（例如手机 App 的）`, `${skipped.site} not for a web address (such as phone apps)`],
    [skipped.username, `${skipped.username} 条没有用户名`, `${skipped.username} without a user name`],
    [skipped.password, `${skipped.password} 条密码为空或太长`, `${skipped.password} with an empty or too long password`],
    [skipped.full, `${skipped.full} 条超出了 2000 个的上限`, `${skipped.full} over the limit of 2000`],
  ].filter(([count]) => count).map(([, zh, en]) => t(zh, en));
  async function toTrash() {
    setError('');
    setTrash('busy');
    try { setTrash(await desktop.vault.trashImport() ? 'done' : ''); cue('note'); }
    catch (failure) { setTrash(''); setError(bridgeText(failure)); }
  }
  const count = (value, zh, en) => <li><b>{value}</b>{t(zh, en)}</li>;
  return (
    <div className="vault-import" ref={box} role="status">
      <p className="vault-import-head"><FileUp size={15} />{t(`已读完 ${result.file}，共 ${result.rows} 条。`, `Read ${result.file}: ${result.rows} ${result.rows === 1 ? 'entry' : 'entries'}.`)}
        <button className="icon-button" title={t('关闭', 'Close')} onClick={onClose}><X size={14} /></button></p>
      <ul className="vault-import-counts">
        {count(added, '新增', 'added')}
        {count(updated, '更新了密码', 'updated')}
        {count(same, '已有，没变', 'already saved')}
        {left ? count(left, '跳过', 'skipped') : null}
      </ul>
      {reasons.length ? <small>{t(`跳过的：${reasons.join('，')}。`, `Skipped: ${reasons.join(', ')}.`)}</small> : null}
      {trash === 'done' ? <p className="vault-note"><CheckCircle2 size={14} />{t('已移到回收站。清空回收站后就彻底删掉了。', 'Moved to the Recycle Bin. Empty the Recycle Bin to delete it for good.')}</p> : (
        <div className="vault-import-warn">
          <ShieldAlert size={16} />
          <span>{t('这个 CSV 文件里的密码都是明文，谁打开都能看到。导入好了，建议把它删掉。', 'This CSV file holds the passwords in plain text, readable by anyone who opens it. Now that they are imported, delete it.')}</span>
          <button className="button small" onClick={toTrash} disabled={trash === 'busy'}><Trash2 size={13} />{t('移到回收站', 'Move to the Recycle Bin')}</button>
        </div>
      )}
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  );
}

// 自动登录 is the Dayjob browser's setting; it is shown here with the passwords it uses.
function AutoLogin() {
  const { t } = useI18n();
  const [on, setOn] = useState(null);
  useEffect(() => {
    if (!desktop?.browser) return undefined;
    desktop.browser.getState().then(state => setOn(state.autoLogin !== false)).catch(() => {});
    return desktop.browser.onState(state => setOn(state.autoLogin !== false));
  }, []);
  if (on === null) return null;
  const toggle = event => desktop.browser.setAutoLogin(event.target.checked).then(state => setOn(state.autoLogin)).catch(() => {});
  return <label className="check-line vault-auto-login"><input type="checkbox" checked={on} onChange={toggle} />{t('在 Dayjob 浏览器打开登录页时，自动填好并登录', 'Fill in and sign in by itself on login pages in the Dayjob browser')}</label>;
}

const VAULT_PAGE = 30;

function PasswordVault() {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [lockMode, setLockMode] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [arrived, setArrived] = useState(null);
  const [imported, setImported] = useState(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(VAULT_PAGE);
  useEffect(() => {
    if (!desktop?.vault) return undefined;
    const load = () => desktop.vault.list().then(setData).catch(() => {});
    load();
    return desktop.vault.onChanged(load);
  }, []);
  useEffect(() => {
    if (!note) return undefined;
    const timer = setTimeout(() => setNote(''), 2500);
    return () => clearTimeout(timer);
  }, [note]);
  if (!desktop?.vault) return null;
  const NOTES = { opened: ['密码箱已打开。', 'The vault is open.'], reset: ['密码箱已清空。', 'The vault is empty.'], set: ['开箱密码已设好。', 'The vault password is set.'],
    change: ['开箱密码已修改。', 'The vault password is changed.'], remove: ['开箱密码已取消。', 'The vault password is removed.'], closed: ['密码箱已锁上。', 'The vault is locked.'] };
  function changed(list, what) {
    setData(list);
    setLockMode(null);
    setEditing(null);
    setNote(NOTES[what] ? t(...NOTES[what]) : '');
    cue('note');
  }
  async function closeVault() {
    try { changed(await desktop.vault.close(), 'closed'); } catch (failure) { setError(bridgeText(failure)); }
  }
  async function saved(entry) {
    setEditing(null);
    setData(await desktop.vault.list());
    setArrived(entry.id);
    cue('note');
  }
  async function importCsv() {
    setError('');
    setImporting(true);
    try {
      const result = await desktop.vault.importCsv();
      if (result) { setImported(result); setData(await desktop.vault.list()); cue('success'); }
    } catch (failure) { setError(bridgeText(failure)); }
    finally { setImporting(false); }
  }
  function remove(entry, row) {
    if (!window.confirm(t(`删除 ${entry.site} 上 ${entry.username} 的密码？`, `Delete the password for ${entry.username} on ${entry.site}?`))) return;
    setError('');
    leaveThen(row, 'fold', async () => {
      try { setData(await desktop.vault.remove(entry.id)); } catch (failure) { setError(bridgeText(failure)); return false; }
      return true;
    });
  }
  const words = query.trim().toLowerCase();
  const matching = (data?.entries || []).filter(entry => !words || entry.site.includes(words) || entry.username.toLowerCase().includes(words));
  return (
    <section className="card-section" id="vault">
      <h2><KeyRound size={18} />{t('密码保管', 'Passwords')}</h2>
      <p className="hint">{t('密码只保存在这台电脑上，由系统加密；只会在 Dayjob 浏览器打开对应网站的登录页时自动填进去并登录，不会再显示出来，也不会交给 Claude。可以从 Edge、Chrome 导出的 CSV 一次导入。',
        'Passwords stay on this computer, encrypted by the system. They are only filled into their own site\'s login page in the Dayjob browser to sign in, never shown again and never given to Claude. A CSV exported from Edge or Chrome imports them all at once.')}</p>
      {data && !data.available ? <p className="notice error">{t('这台电脑不能加密保存密码，所以暂时不能使用。', 'This computer cannot encrypt saved passwords, so the vault is not available.')}</p> : null}
      {note ? <p className="vault-note"><CheckCircle2 size={14} />{note}</p> : null}
      {data?.locked ? <VaultUnlock count={data.count} onChanged={changed} /> : null}
      {imported && !data?.locked ? <ImportResult key={`${imported.file}${imported.rows}${imported.added}`} result={imported} onClose={() => setImported(null)} /> : null}
      {!data?.locked && data?.entries.length > 8 ? (
        <label className="vault-search"><Search size={14} />
          <input type="search" value={query} onChange={event => { setQuery(event.target.value); setShown(VAULT_PAGE); }} placeholder={t(`在 ${data.entries.length} 个密码里搜索网站或用户名`, `Search ${data.entries.length} passwords by site or user name`)}
            aria-label={t('搜索密码', 'Search passwords')} />
        </label>
      ) : null}
      {data?.locked ? null : data?.entries.length ? (
        <ul className="vault-list">
          {matching.slice(0, shown).map(entry => (
            <li key={entry.id} className={arrived === entry.id ? 'arrived' : undefined}>
              <KeyRound size={14} />
              <span className="vault-site">{entry.site}</span>
              <span className="vault-user">{entry.username}</span>
              <small>{entry.usedAt ? t(`上次填写 ${formatTime(entry.usedAt)}`, `Last filled ${formatTime(entry.usedAt)}`) : t('还没填写过', 'Not filled yet')}</small>
              <button className="icon-button" title={t('修改', 'Edit')} onClick={() => setEditing(entry)}><Pencil size={14} /></button>
              <button className="icon-button" title={t('删除', 'Delete')} onClick={event => remove(entry, event.currentTarget.closest('li'))}><Trash2 size={14} /></button>
            </li>
          ))}
          {!matching.length ? <li className="vault-none">{t('没有找到。', 'Nothing found.')}</li> : null}
        </ul>
      ) : data?.available ? <p className="hint">{t('还没有保存的密码。', 'No saved passwords yet.')}</p> : null}
      {!data?.locked && matching.length > shown ? (
        <button className="link vault-more" onClick={() => setShown(value => value + VAULT_PAGE)}>
          {t(`再显示 ${Math.min(VAULT_PAGE, matching.length - shown)} 个（还有 ${matching.length - shown} 个）`, `Show ${Math.min(VAULT_PAGE, matching.length - shown)} more (${matching.length - shown} left)`)}</button>
      ) : null}
      {data?.locked ? null : editing ? <VaultForm key={editing === 'new' ? 'new' : editing.id} entry={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSaved={saved} />
        : lockMode ? <LockForm key={lockMode} mode={lockMode} onCancel={() => setLockMode(null)} onDone={changed} />
        : (
          <div className="form-actions vault-actions">
            <button className="button" onClick={() => setEditing('new')} disabled={!data?.available}><Plus size={15} />{t('添加密码', 'Add a password')}</button>
            <button className="button" onClick={importCsv} disabled={!data?.available || importing}>{importing ? <LoaderCircle size={15} className="spin" /> : <FileUp size={15} />}{t('从浏览器导入', 'Import from a browser')}</button>
            {data?.lock ? (
              <>
                <button className="button" onClick={closeVault}><Lock size={15} />{t('锁上', 'Lock')}</button>
                <button className="link" onClick={() => setLockMode('change')}>{t('修改开箱密码', 'Change the vault password')}</button>
                <button className="link" onClick={() => setLockMode('remove')}>{t('取消开箱密码', 'Remove the vault password')}</button>
              </>
            ) : <button className="button" onClick={() => setLockMode('set')} disabled={!data?.available}><Lock size={15} />{t('设置开箱密码', 'Set a vault password')}</button>}
          </div>
        )}
      {data?.locked || editing || lockMode ? null : (
        <details className="vault-how">
          <summary>{t('怎么从 Edge 导出密码？', 'How do I export passwords from Edge?')}</summary>
          <ol>
            <li>{t('在 Edge 里打开 设置 → 个人资料 → 密码（新版 Edge 会打开“钱包”里的密码页）。', 'In Edge, open Settings → Profiles → Passwords (newer Edge opens the passwords page in Wallet).')}</li>
            <li>{t('在“已保存的密码”旁边点 ⋯（更多操作），选“导出密码”，按提示验证 Windows 密码或 PIN，存成 CSV 文件。', 'Next to “Saved passwords”, click ⋯ (More actions), choose “Export passwords”, confirm with your Windows password or PIN, and save the CSV file.')}</li>
            <li>{t('回到这里点“从浏览器导入”，选那个文件。Chrome 和 Firefox 导出的 CSV 也可以。', 'Come back here, click “Import from a browser” and choose that file. CSV exports from Chrome and Firefox work too.')}</li>
          </ol>
          <small>{t('文件只在这台电脑上读取；密码导入后由系统加密保存，不会显示出来，也不会交给 Claude。', 'The file is read on this computer only; the passwords are kept encrypted by the system, never shown, and never given to Claude.')}</small>
        </details>
      )}
      {data?.available && !data?.locked ? <AutoLogin /> : null}
      {error ? <p className="notice error">{error}</p> : null}
    </section>
  );
}

function Background({ boot, reload }) {
  const { t } = useI18n();
  const [error, setError] = useState('');
  if (!desktop) return null;
  async function toggle(event) {
    setError('');
    try { await api('/api/settings', { method: 'PATCH', body: { desktop: { closeToTray: event.target.checked } } }); await reload(); }
    catch (failure) { setError(serverText(failure.message)); }
  }
  return (
    <section className="card-section">
      <h2><Power size={18} />{t('关闭窗口时', 'Closing the window')}</h2>
      <p className="hint">{t('开着这一项，关掉窗口后 Dayjob 留在任务栏右下角的托盘里，按时做每日抓取、发提醒，Claude 也能随时通过 MCP 使用它；要完全退出，在托盘图标的菜单里点“退出 Dayjob”。关掉这一项，关窗口就完全退出，不在后台运行；错过的每日抓取会在当天下次打开 Dayjob 时补上。',
        'With this on, closing the window leaves Dayjob in the tray at the bottom right of the taskbar, so the daily search and reminders still run and Claude can use it through MCP at any time; to quit completely, choose “Quit Dayjob” from the tray icon\'s menu. With it off, closing the window quits Dayjob and nothing keeps running; a daily search it missed runs when you next open Dayjob that day.')}</p>
      <div className="form-grid">
        <label className="check-line"><input type="checkbox" checked={boot.settings.desktop.closeToTray} onChange={toggle} />{t('关闭窗口后继续在后台运行', 'Keep running in the tray')}</label>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </section>
  );
}

const UPDATE_STATES = { idle: ['还没有检查', 'Not checked yet'], checking: ['正在检查…', 'Checking…'], latest: ['已是最新版本', 'Dayjob is up to date'],
  error: ['检查失败', 'The check failed'], downloading: ['正在下载新版本…', 'Downloading the new version…'], downloaded: ['新版本已下载，重启即可更新', 'Downloaded; restart to update'],
  installing: ['正在准备安装…', 'Preparing to install…'],
  unsupported: ['开发版不检查更新', 'Development builds do not check for updates'] };

function Updates({ boot, reload, update }) {
  const { t } = useI18n();
  const [error, setError] = useState('');
  if (!desktop?.updates || !update) return null;
  async function toggle(event) {
    setError('');
    try { await api('/api/settings', { method: 'PATCH', body: { updates: { autoCheck: event.target.checked } } }); await reload(); }
    catch (failure) { setError(serverText(failure.message)); }
  }
  const text = update.status === 'available' ? t(`有新版本 v${update.latest}`, `Version ${update.latest} is available`) : t(...(UPDATE_STATES[update.status] || [update.status, update.status]));
  return (
    <section className="card-section">
      <h2><Download size={18} />{t('更新', 'Updates')}</h2>
      <p className="hint">{t('从 GitHub Releases 检查新版本。有新版本时，左侧栏的“检查更新”会变成圆形下载按钮；下载完点“重启并更新”，数据会保留。',
        'Dayjob looks for new versions on GitHub Releases. When one is out, “Check for updates” in the sidebar turns into a round download button; once downloaded, click “Restart to update”. Your data stays.')}</p>
      <p className={`status-line ${update.status === 'error' || update.problem ? 'off' : 'ok'}`}>
        {update.status === 'latest' ? <CheckCircle2 size={15} /> : null}{t(`当前 v${update.version} · `, `Current v${update.version} · `)}{text}
        {update.checkedAt ? <span className="muted">{t(` · 上次检查 ${new Date(update.checkedAt).toLocaleString('zh-CN')}`, ` · last checked ${new Date(update.checkedAt).toLocaleString('en-US')}`)}</span> : null}
      </p>
      {update.problem || update.error ? <p className="notice error">{updateProblem(t, update)}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      <div className="form-grid">
        <label className="check-line"><input type="checkbox" checked={boot.settings.updates.autoCheck} onChange={toggle} />{t('每天自动检查一次', 'Check once a day')}</label>
      </div>
      {update.portable ? <p className="hint">{t('免安装版不能自己替换，下载按钮会在浏览器里下载新的免安装版。', 'The portable app cannot replace itself; its download button gets the new portable app in your browser.')}</p> : null}
      <div className="form-actions">
        <button className="button" data-fx="refresh" onClick={() => desktop.updates.check()} disabled={['checking', 'downloading', 'downloaded', 'installing', 'unsupported'].includes(update.status)}>
          {update.status === 'checking' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{t('立即检查', 'Check now')}
        </button>
      </div>
    </section>
  );
}

// After the header switch turned the theme against the clock: until when it holds, and a way back to the clock now.
function HoldNote({ hold }) {
  const { t } = useI18n();
  const at = new Date(hold.until);
  const until = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return (
    <p className="theme-hold">
      {hold.night ? t(`现在临时换成了夜晚，到 ${until} 再按时间切换。`, `Night for now, by the clock again at ${until}.`) : t(`现在临时换成了白天，到 ${until} 再按时间切换。`, `Day for now, by the clock again at ${until}.`)}
      <button className="link" onClick={releaseThemeHold}>{t('现在就按时间', 'Follow the clock now')}</button>
    </p>
  );
}

export function SettingsView({ boot, reload, update, focus }) {
  const { t } = useI18n();
  const settings = boot.settings;
  const [form, setForm] = useState({ scheduleEnabled: settings.schedule.enabled, time: settings.schedule.time,
    followUpDays: settings.tracking.followUpDays, ghostDays: settings.tracking.ghostDays, checkClosed: settings.tracking.checkClosed,
    desktop: settings.notifications.desktop, minScore: settings.notifications.minScore, pythonCommand: settings.jobspy.pythonCommand,
    retentionDays: settings.retentionDays });
  const look = useThemeSettings();
  const [sites, setSites] = useState(boot.sites);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saved, flashSaved] = useSaved();
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  useEffect(() => { desktop?.getInfo().then(setInfo).catch(() => {}); }, []);
  useEffect(() => { if (focus) document.getElementById(focus)?.scrollIntoView({ block: 'start' }); }, [focus]);

  async function save(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      await api('/api/settings', { method: 'PATCH', body: {
        schedule: { enabled: form.scheduleEnabled, time: form.time },
        tracking: { followUpDays: Number(form.followUpDays), ghostDays: Number(form.ghostDays), checkClosed: form.checkClosed },
        notifications: { desktop: form.desktop, minScore: Number(form.minScore) },
        jobspy: { pythonCommand: form.pythonCommand },
        retentionDays: Number(form.retentionDays),
      } });
      await reload();
      setSites(await api('/api/sites?refresh=1'));
      flashSaved();
    } catch (failure) { setError(failure.message); }
  }
  const jobspy = sites.find(site => site.engine === 'jobspy');

  return (
    <section className="settings-page">
      <header className="view-header"><ListenWave /><div className="title-block"><ViewDate /><h1>{t('设置', 'Settings')}</h1></div></header>
      <form className="card-section" onSubmit={save}>
        <h2>{t('每日抓取', 'Daily search')}</h2>
        <div className="form-grid">
          <label className="check-line"><input type="checkbox" checked={form.scheduleEnabled} onChange={event => set('scheduleEnabled', event.target.checked)} />{t('每天自动抓取', 'Search every day')}</label>
          <label>{t('时间', 'Time')}<TimeField value={form.time} onChange={event => set('time', event.target.value)} /><small>{t('电脑关机错过时，下次打开 Dayjob 会补上当天的抓取。', 'If the computer was off, Dayjob catches up when it next opens that day.')}</small></label>
          <label>{t('岗位保留天数', 'Keep jobs (days)')}<input type="number" min={7} max={365} value={form.retentionDays} onChange={event => set('retentionDays', event.target.value)} /><small>{t('未收藏、未投递的旧岗位到期清理。', 'Old jobs you did not save or apply to are cleared after this.')}</small></label>
        </div>
        <h2>{t('投递追踪', 'Application tracking')}</h2>
        <div className="form-grid">
          <label>{t('跟进提醒（天）', 'Follow-up reminder (days)')}<input type="number" min={0} max={90} value={form.followUpDays} onChange={event => set('followUpDays', event.target.value)} /><small>{t('投递或状态变化后多少天提醒你跟进；0 为关闭。', 'Days after applying or a status change before Dayjob reminds you; 0 turns it off.')}</small></label>
          <label>{t('无回音提示（天）', 'No-reply flag (days)')}<input type="number" min={0} max={180} value={form.ghostDays} onChange={event => set('ghostDays', event.target.value)} /><small>{t('“已投递”状态超过这么多天没有变化时提示。', 'Flag an application still at “Applied” after this many days.')}</small></label>
          <label className="check-line"><input type="checkbox" checked={form.checkClosed} onChange={event => set('checkClosed', event.target.checked)} />{t('每天检查已投递和已收藏的岗位是否关闭', 'Check daily whether applied and saved jobs have closed')}</label>
        </div>
        <h2>{t('通知', 'Notifications')}</h2>
        <div className="form-grid">
          <label className="check-line"><input type="checkbox" checked={form.desktop} onChange={event => set('desktop', event.target.checked)} />{t('Windows 桌面通知', 'Windows desktop notifications')}</label>
          <label>{t('高匹配分数线', 'Strong-match score')}<input type="number" min={0} max={100} value={form.minScore} onChange={event => set('minScore', event.target.value)} /><small>{t('每日汇总里单独列出高于这个分数的新岗位。', 'The daily summary lists new jobs scoring at least this.')}</small></label>
        </div>
        <h2>{t('JobSpy（可选）', 'JobSpy (optional)')}</h2>
        <p className="hint">{t('Glassdoor、ZipRecruiter、Google Jobs 需要 Python 版 JobSpy：安装 Python 后运行 ', 'Glassdoor, ZipRecruiter and Google Jobs need the Python JobSpy: install Python, then run ')}<code>pip install python-jobspy</code>
          {t('。LinkedIn、Indeed 和公司招聘页不需要。', '. LinkedIn, Indeed and company boards do not need it.')}</p>
        <div className="form-grid">
          <label>{t('Python 命令', 'Python command')}<input value={form.pythonCommand} onChange={event => set('pythonCommand', event.target.value)} maxLength={1024} placeholder="python" /></label>
        </div>
        <p className={`status-line ${jobspy?.available ? 'ok' : 'off'}`}>{jobspy?.available ? <CheckCircle2 size={15} /> : null}{jobspy?.available ? jobspy.detail : t('未检测到 JobSpy。装好后点“保存设置”会重新检测。', 'JobSpy was not found. Install it, then click “Save settings” to check again.')}</p>
        {error ? <p className="notice error">{error}</p> : null}
        {message ? <p className="notice">{message}</p> : null}
        <div className="form-actions"><button className="button primary" type="submit"><SavedLabel saved={saved}>{t('保存设置', 'Save settings')}</SavedLabel></button></div>
      </form>
      <ClaudeConnection />
      <BrowserData />
      <PasswordVault />
      <Background boot={boot} reload={reload} />
      <Updates boot={boot} reload={reload} update={update} />
      <SoundSettings />
      <section className="card-section">
        <h2>{t('语言、外观与数据', 'Language, look and data')}</h2>
        <div className="option-row">
          <span>{t('界面语言', 'Language')}</span>
          <LanguageSwitch />
          <small>{t('通知和托盘菜单也会跟着切换。AI 分析的语言在“简历与 AI”里设置。', 'Notifications and the tray menu follow it. Set the AI analysis language under Resume & AI.')}</small>
        </div>
        <div className="option-row">
          <span>{t('外观', 'Appearance')}</span>
          <div className="segmented">
            {[['time', '按时间', 'By the clock', Clock3, 'hourglass'], ['system', '跟随系统', 'System', Monitor, 'screen'], ['light', '浅色', 'Light', Sun, 'sunrise'], ['dark', '深色', 'Dark', LampDesk, 'lamp']].map(([value, zh, en, Icon, fx]) => (
              <button key={value} className={look.choice === value ? 'active' : ''} data-fx={fx} onClick={() => setThemeChoice(value)}><Icon size={14} />{t(zh, en)}</button>
            ))}
          </div>
          {look.choice === 'time' ? (
            <div className="theme-hours">
              <label><Sun size={14} />{t('白天从', 'Day from')}<TimeField value={look.hours.day} onChange={event => setThemeHours({ day: event.target.value })} /></label>
              <label><LampDesk size={14} />{t('黑夜从', 'Night from')}<TimeField value={look.hours.night} onChange={event => setThemeHours({ night: event.target.value })} /></label>
              {look.hold ? <HoldNote hold={look.hold} /> : null}
            </div>
          ) : null}
        </div>
        <p className="hint">{t('数据库：', 'Database: ')}{boot.dataFile} · Dayjob {boot.version}</p>
        {desktop ? <button className="button" data-fx="folder" onClick={() => desktop.openDataFolder().catch(failure => setError(failure.message))}><FolderOpen size={15} />{t('打开数据文件夹', 'Open data folder')}</button> : null}
        {info?.portable ? <p className="hint">{t('便携版不会写入 Claude 配置；安装版才能稳定连接 MCP。', 'The portable version does not write Claude\'s config; install Dayjob for a lasting MCP connection.')}</p> : null}
      </section>
    </section>
  );
}
