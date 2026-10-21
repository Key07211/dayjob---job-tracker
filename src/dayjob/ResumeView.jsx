import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileUp, LoaderCircle, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { formatTime } from './format.js';
import { useI18n } from '../i18n.jsx';
import { serverText } from './server-text.js';

const MAX_BYTES = 8 * 1024 * 1024;

function toBase64(file, failed) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(failed));
    reader.readAsDataURL(file);
  });
}

function Resumes({ resumes, reload }) {
  const { t } = useI18n();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const active = resumes.find(resume => resume.active);
  async function upload(file) {
    if (!file) return;
    setError('');
    if (file.size > MAX_BYTES) { setError(t('文件超过 8 MB。', 'The file is larger than 8 MB.')); return; }
    setBusy(true);
    try {
      await api('/api/resumes', { method: 'POST', body: { name: file.name, mime: file.type, data: await toBase64(file, t('读取文件失败。', 'Could not read the file.')) } });
      await reload();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function activate(resume) {
    try { await api(`/api/resumes/${resume.id}`, { method: 'PATCH', body: { active: true } }); await reload(); }
    catch (failure) { setError(failure.message); }
  }
  async function remove(resume) {
    if (!window.confirm(t(`删除简历“${resume.name}”？基于它的打分也会删除。`, `Delete the resume “${resume.name}”? Scores based on it are deleted too.`))) return;
    try { await api(`/api/resumes/${resume.id}`, { method: 'DELETE' }); await reload(); }
    catch (failure) { setError(failure.message); }
  }
  return (
    <section className="card-section">
      <h2>{t('简历', 'Resume')}</h2>
      <p className="hint">{t('支持 PDF、Word（.docx）和纯文本。只保存提取出的文字，不保存原文件；数据只在本机。换一份简历后，岗位会按新简历重新打分。',
        'PDF, Word (.docx) or plain text. Dayjob keeps only the extracted text, never the file, and only on this computer. After you switch resumes, jobs are scored again against the new one.')}</p>
      <div className={`dropzone${dragging ? ' dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]); }}>
        {busy ? <LoaderCircle className="spin" /> : <FileUp size={24} />}
        <p>{busy ? t('正在读取简历…', 'Reading your resume…') : t('把简历拖到这里，或', 'Drop your resume here, or')}</p>
        <button className="button" onClick={() => input.current?.click()} disabled={busy}>{t('选择文件', 'Choose a file')}</button>
        <input ref={input} type="file" hidden accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          onChange={event => upload(event.target.files[0])} />
      </div>
      {error ? <p className="notice error">{error}</p> : null}
      {resumes.length ? (
        <ul className="resume-list">
          {resumes.map(resume => (
            <li key={resume.id} className={resume.active ? 'active' : ''}>
              <div><strong>{resume.name}</strong><span>{formatTime(resume.uploadedAt)} · {t(`${resume.characters.toLocaleString()} 字符`, `${resume.characters.toLocaleString()} characters`)}</span></div>
              {resume.active ? <span className="active-tag"><CheckCircle2 size={14} />{t('正在使用', 'In use')}</span> : <button className="button small" onClick={() => activate(resume)}>{t('使用这份', 'Use this one')}</button>}
              <button className="icon-button" title={t('删除', 'Delete')} onClick={() => remove(resume)}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      {active ? <details className="resume-preview"><summary>{t('查看提取出的文字（前 600 字）', 'Show the extracted text (first 600 characters)')}</summary><pre>{active.preview}</pre></details> : null}
    </section>
  );
}

function AiSettings({ boot, reload, status }) {
  const { t } = useI18n();
  const ai = boot.settings.ai;
  const [form, setForm] = useState({ provider: ai.provider, claudeCommand: ai.claudeCommand, model: ai.model, effort: ai.effort || 'medium',
    language: ai.language, autoScore: ai.autoScore, maxPerRun: ai.maxPerRun, apiKey: '' });
  const [scoring, setScoring] = useState(boot.scoring);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  async function refresh() {
    setChecking(true);
    try { setScoring(await api('/api/scoring/status?refresh=1')); } catch (failure) { setError(failure.message); } finally { setChecking(false); }
  }
  useEffect(() => { if (status?.scoring) setScoring(status.scoring); }, [status?.scoring]);

  async function save(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    const body = { provider: form.provider, claudeCommand: form.claudeCommand, model: form.model, effort: form.effort, language: form.language,
      autoScore: form.autoScore, maxPerRun: Number(form.maxPerRun), ...(form.apiKey ? { apiKey: form.apiKey } : {}) };
    try {
      await api('/api/settings', { method: 'PATCH', body: { ai: body } });
      set('apiKey', '');
      await reload();
      await refresh();
      setMessage(t('已保存。', 'Saved.'));
    } catch (failure) { setError(failure.message); }
  }
  async function clearKey() {
    try { await api('/api/settings', { method: 'PATCH', body: { ai: { apiKey: null } } }); await reload(); await refresh(); }
    catch (failure) { setError(failure.message); }
  }
  async function scoreAll() {
    setMessage('');
    try { await api('/api/scores', { method: 'POST', body: { limit: Number(form.maxPerRun) } }); setMessage(t('已开始给未打分的岗位打分。', 'Scoring the unscored jobs.')); }
    catch (failure) { setError(failure.message); }
  }

  return (
    <form className="card-section" onSubmit={save}>
      <h2><Sparkles size={18} />{t('AI 打分', 'AI scoring')}</h2>
      <p className={`status-line ${scoring.available ? 'ok' : 'off'}`}>
        {scoring.available ? <CheckCircle2 size={15} /> : null}{serverText(scoring.detail)}
        <button type="button" className="icon-button" title={t('重新检测', 'Check again')} onClick={refresh} disabled={checking}>{checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}</button>
      </p>
      <div className="choice-row">
        <label className={form.provider === 'claude-cli' ? 'selected' : ''}>
          <input type="radio" name="provider" checked={form.provider === 'claude-cli'} onChange={() => set('provider', 'claude-cli')} />
          <strong>{t('本机 Claude Code', 'Claude Code on this computer')}</strong><span>{t('用你已登录的 Claude Code（claude -p），不需要 API key。', 'Uses your signed-in Claude Code (claude -p). No API key needed.')}</span>
        </label>
        <label className={form.provider === 'anthropic-api' ? 'selected' : ''}>
          <input type="radio" name="provider" checked={form.provider === 'anthropic-api'} onChange={() => set('provider', 'anthropic-api')} />
          <strong>Claude API</strong><span>{t('用你自己的 Anthropic API key，按用量计费。', 'Uses your own Anthropic API key, billed by usage.')}</span>
        </label>
      </div>
      <div className="form-grid">
        {form.provider === 'claude-cli' ? (
          <label>{t('Claude Code 路径（可选）', 'Claude Code path (optional)')}<input value={form.claudeCommand} onChange={event => set('claudeCommand', event.target.value)} placeholder={t('自动查找 claude', 'Finds claude automatically')} maxLength={1024} />
            <small>{t('找不到时填写，例如 C:\\Users\\你\\.local\\bin\\claude.exe', 'Fill in if it is not found, e.g. C:\\Users\\you\\.local\\bin\\claude.exe')}</small></label>
        ) : (
          <label>API key
            <input type="password" value={form.apiKey} onChange={event => set('apiKey', event.target.value)} autoComplete="off"
              placeholder={ai.hasApiKey ? t('已保存（输入新的可替换）', 'Saved (type a new one to replace it)') : ai.apiKeyFromEnv ? t('使用环境变量 ANTHROPIC_API_KEY', 'Using ANTHROPIC_API_KEY from the environment') : 'sk-ant-…'} />
            {ai.hasApiKey ? <button type="button" className="link" onClick={clearKey}>{t('清除已保存的 key', 'Remove the saved key')}</button>
              : <small>{t('只保存在本机数据库，不会显示回界面。', 'Stored only in the local database and never shown again.')}</small>}
          </label>
        )}
        <label>{t('模型（可选）', 'Model (optional)')}<input value={form.model} onChange={event => set('model', event.target.value)} placeholder={form.provider === 'anthropic-api' ? 'claude-opus-5-5' : t('使用 Claude Code 默认模型', 'Claude Code\'s default model')} maxLength={100} /></label>
        {form.provider === 'anthropic-api' ? (
          <label>{t('思考力度', 'Effort')}
            <select value={form.effort} onChange={event => set('effort', event.target.value)}>
              <option value="low">{t('低（更快更省）', 'Low (faster, cheaper)')}</option><option value="medium">{t('中', 'Medium')}</option><option value="high">{t('高（更细致）', 'High (more thorough)')}</option>
            </select>
          </label>
        ) : null}
        <label>{t('分析语言', 'Analysis language')}
          <select value={form.language} onChange={event => set('language', event.target.value)}>
            <option value="zh">中文</option><option value="en">English</option>
          </select>
        </label>
        <label>{t('每次最多打分', 'Scores per run')}<input type="number" min={1} max={200} value={form.maxPerRun} onChange={event => set('maxPerRun', event.target.value)} /><small>{t('每日抓取后按这个上限自动打分。', 'The daily search scores up to this many jobs.')}</small></label>
        <label className="check-line"><input type="checkbox" checked={form.autoScore} onChange={event => set('autoScore', event.target.checked)} />{t('抓取后自动打分', 'Score after each search')}</label>
      </div>
      {form.provider === 'anthropic-api' ? <p className="hint">{t('使用 Claude API 时开启了服务器端回退：如果所选模型拒绝了某次请求，Anthropic 会自动换用备用模型重试一次。',
        'Server-side fallback is on for the Claude API: if the chosen model declines a request, Anthropic retries it once with a fallback model.')}</p> : null}
      <p className="hint">{t('也可以在 Claude Code / Claude Desktop 里通过 Dayjob MCP 让 Claude 读取岗位和简历、直接写回分析（设置 → 连接 Claude）。',
        'You can also ask Claude in Claude Code or Claude Desktop to read jobs and your resume through the Dayjob MCP and write its analysis back (Settings → Connect Claude).')}</p>
      {error ? <p className="notice error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" onClick={scoreAll} disabled={!boot.resumes.length}><Sparkles size={15} />{t('给未打分的岗位打分', 'Score unscored jobs')}</button>
        <button type="submit" className="button primary">{t('保存', 'Save')}</button>
      </div>
    </form>
  );
}

export function ResumeView({ boot, reload, status }) {
  const { t } = useI18n();
  return (
    <section className="settings-page">
      <header className="view-header"><div><h1>{t('简历与 AI', 'Resume & AI')}</h1><p>{t('AI 会对照你的简历给每个岗位打 0–100 分，并列出匹配点、差距和可补充的关键词。', 'AI rates each job 0–100 against your resume and lists strengths, gaps and keywords to add.')}</p></div></header>
      <Resumes resumes={boot.resumes} reload={reload} />
      <AiSettings boot={boot} reload={reload} status={status} />
    </section>
  );
}
