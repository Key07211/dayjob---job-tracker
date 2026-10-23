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

const MAX_RESUMES = 3;

function Resumes({ resumes, reload }) {
  const { t } = useI18n();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const full = resumes.length >= MAX_RESUMES;
  async function upload(file) {
    if (!file || full) return;
    setError('');
    if (file.size > MAX_BYTES) { setError(t('文件超过 8 MB。', 'The file is larger than 8 MB.')); return; }
    setBusy(true);
    try {
      await api('/api/resumes', { method: 'POST', body: { name: file.name, mime: file.type, data: await toBase64(file, t('读取文件失败。', 'Could not read the file.')) } });
      await reload();
    } catch (failure) { setError(serverText(failure.message)); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function remove(resume) {
    if (!window.confirm(t(`删除简历“${resume.name}”？基于它的打分也会删除，相关岗位会改用其他简历。`, `Delete the resume “${resume.name}”? Scores based on it are deleted too, and its jobs move to your other resumes.`))) return;
    try { await api(`/api/resumes/${resume.id}`, { method: 'DELETE' }); await reload(); }
    catch (failure) { setError(serverText(failure.message)); }
  }
  return (
    <section className="card-section">
      <h2>{t(`简历（${resumes.length}/${MAX_RESUMES}）`, `Resumes (${resumes.length}/${MAX_RESUMES})`)}</h2>
      <p className="hint">{t('最多 3 份，比如分别针对数据分析和软件工程。打分时，Dayjob 会给每个岗位自动选关键词重合度最高的那份简历。支持 PDF、Word（.docx）和纯文本；只保存提取出的文字，不保存原文件，数据只在本机。',
        'Up to 3, for example one for data roles and one for software roles. Each job is scored against the resume that shares the most keywords with it. PDF, Word (.docx) or plain text; Dayjob keeps only the extracted text, never the file, and only on this computer.')}</p>
      {full ? <p className="notice">{t('已经有 3 份简历。删除一份后才能再上传。', 'You have 3 resumes. Delete one to upload another.')}</p> : (
        <div className={`dropzone${dragging ? ' dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]); }}>
          {busy ? <LoaderCircle className="spin" /> : <FileUp size={24} />}
          <p>{busy ? t('正在读取简历…', 'Reading your resume…') : t('把简历拖到这里，或', 'Drop a resume here, or')}</p>
          <button className="button" onClick={() => input.current?.click()} disabled={busy}>{t('选择文件', 'Choose a file')}</button>
          <input ref={input} type="file" hidden accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            onChange={event => upload(event.target.files[0])} />
        </div>
      )}
      {error ? <p className="notice error">{error}</p> : null}
      {resumes.length ? (
        <ul className="resume-list">
          {resumes.map(resume => (
            <li key={resume.id}>
              <div><strong>{resume.name}</strong><span>{formatTime(resume.uploadedAt)} · {t(`${resume.characters.toLocaleString()} 字符`, `${resume.characters.toLocaleString()} characters`)}</span>
                <details className="resume-preview"><summary>{t('查看提取出的文字（前 600 字）', 'Show the extracted text (first 600 characters)')}</summary><pre>{resume.preview}</pre></details>
              </div>
              <button className="icon-button" title={t('删除', 'Delete')} onClick={() => remove(resume)}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const SCORE_MODES = [
  { id: 'auto', label: ['每次抓取后自动打分', 'After every search'],
    detail: ['新岗位一抓到就打分（每次最多按上面的上限）。最省事，用量最多。', 'New jobs are scored as they arrive, up to the limit above. Easiest, and uses the most.'] },
  { id: 'saved', label: ['只给收藏的岗位打分', 'Only jobs I save'],
    detail: ['收藏一个岗位时才给它打分，抓取时不打分。', 'A job is scored when you save it. Searches score nothing.'] },
  { id: 'manual', label: ['只在我点的时候打分', 'Only when I ask'],
    detail: ['在岗位详情点“AI 打分”，或在列表里勾选几个一起打分。', 'Click “Score with AI” on a job, or tick a few in the list and score them together.'] },
];

function AiSettings({ boot, reload, status }) {
  const { t } = useI18n();
  const ai = boot.settings.ai;
  const [form, setForm] = useState({ provider: ai.provider, claudeCommand: ai.claudeCommand, model: ai.model, effort: ai.effort || 'medium',
    language: ai.language, scoreMode: ai.scoreMode, maxPerRun: ai.maxPerRun, apiKey: '' });
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
      scoreMode: form.scoreMode, maxPerRun: Number(form.maxPerRun), ...(form.apiKey ? { apiKey: form.apiKey } : {}) };
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
        <label>{t('每次最多打分', 'Scores per run')}<input type="number" min={1} max={200} value={form.maxPerRun} onChange={event => set('maxPerRun', event.target.value)} /><small>{t('一次抓取或一次批量打分最多打这么多个。', 'The most jobs scored by one search or one batch.')}</small></label>
      </div>
      <h3 className="choice-title">{t('什么时候打分', 'When to score')}</h3>
      <div className="choice-row three">
        {SCORE_MODES.map(mode => (
          <label key={mode.id} className={form.scoreMode === mode.id ? 'selected' : ''}>
            <input type="radio" name="scoreMode" checked={form.scoreMode === mode.id} onChange={() => set('scoreMode', mode.id)} />
            <strong>{t(...mode.label)}</strong><span>{t(...mode.detail)}</span>
          </label>
        ))}
      </div>
      <p className="hint">{t('每打一个岗位调用一次 Claude，会用掉 Claude Code 额度（或 API 费用）。选哪份简历是在本机比较关键词，不用额度。',
        'Each scored job is one Claude call and uses your Claude Code allowance (or API credit). Choosing the resume is a keyword comparison on this computer and uses none.')}</p>
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
      <header className="view-header"><div><h1>{t('简历与 AI', 'Resume & AI')}</h1><p>{t('AI 会对照最匹配的那份简历给每个岗位打 0–100 分，并列出匹配点、差距和可补充的关键词。', 'AI rates each job 0–100 against your best-matching resume and lists strengths, gaps and keywords to add.')}</p></div></header>
      <Resumes resumes={boot.resumes} reload={reload} />
      <AiSettings boot={boot} reload={reload} status={status} />
    </section>
  );
}
