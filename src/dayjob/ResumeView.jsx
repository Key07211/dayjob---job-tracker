import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileUp, LoaderCircle, RefreshCw, Sparkles, Trash2, UserRound } from 'lucide-react';
import { api } from '../api.js';
import { formatTime } from './format.js';
import { useI18n } from '../i18n.jsx';
import { serverText } from './server-text.js';
import { EFFORTS, PROVIDERS, effortFor, modelInfo } from '../../server/jobs/scoring/models.mjs';

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

const PROVIDER_GROUPS = [
  { name: 'Claude', items: [
    { id: 'claude-cli', name: ['本机 Claude Code', 'Claude Code on this computer'],
      detail: ['用你已登录的 Claude Code（claude -p），不需要 API key。', 'Uses your signed-in Claude Code (claude -p). No API key needed.'] },
    { id: 'anthropic-api', name: ['Claude API', 'Claude API'], detail: ['用你自己的 Anthropic API key，按用量计费。', 'Uses your own Anthropic API key, billed by usage.'] },
  ] },
  { name: 'ChatGPT', items: [
    { id: 'codex-cli', name: ['本机 Codex', 'Codex on this computer'],
      detail: ['用你以 ChatGPT 账号登录的 Codex（codex exec），不需要 API key。', 'Uses Codex signed in with your ChatGPT account (codex exec). No API key needed.'] },
    { id: 'openai-api', name: ['OpenAI API', 'OpenAI API'], detail: ['用你自己的 OpenAI API key，按用量计费。', 'Uses your own OpenAI API key, billed by usage.'] },
  ] },
];
const MODEL_TAGS = { recommended: ['推荐', 'recommended'], top: ['最强', 'most capable'], fast: ['快、省', 'fast, cheap'], older: ['旧版', 'older'] };
const EFFORT_LABELS = { low: ['低（更快更省）', 'Low (faster, cheaper)'], medium: ['中', 'Medium'], high: ['高（更细致）', 'High (more thorough)'],
  xhigh: ['很高', 'Extra high'], max: ['最高（最慢、用量最多）', 'Max (slowest, uses the most)'] };
const CLI_DEFAULT = { 'claude-cli': ['跟随 Claude Code 的设置', 'Claude Code\'s own setting'], 'codex-cli': ['跟随 Codex 的设置', 'Codex\'s own setting'] };
const CUSTOM = 'custom';
const listed = (provider, model) => PROVIDERS[provider].models.some(item => item.id === model);

function AiSettings({ boot, reload, status }) {
  const { t } = useI18n();
  const ai = boot.settings.ai;
  const [form, setForm] = useState({ provider: ai.provider, claudeCommand: ai.claudeCommand, codexCommand: ai.codexCommand || '', model: ai.model,
    effort: ai.effort || '', language: ai.language, scoreMode: ai.scoreMode, maxPerRun: ai.maxPerRun, apiKey: '', openaiApiKey: '' });
  const [custom, setCustom] = useState(Boolean(ai.model) && !listed(ai.provider, ai.model));
  const [scoring, setScoring] = useState(boot.scoring);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const provider = PROVIDERS[form.provider];
  const model = modelInfo(form.provider, form.model);
  const efforts = model ? model.efforts : EFFORTS;
  const usesKey = form.provider.endsWith('-api');

  // A model from the other family would fail every score, so switching
  // between Claude and ChatGPT starts from that provider's default model.
  function chooseProvider(id) {
    const next = PROVIDERS[id].family === provider.family ? form.model : '';
    if (!next) setCustom(false);
    setForm({ ...form, provider: id, model: next, effort: effortFor(id, next, form.effort) });
  }
  function chooseModel(value) {
    if (value === CUSTOM) { setCustom(true); return; }
    setCustom(false);
    setForm({ ...form, model: value, effort: effortFor(form.provider, value, form.effort) });
  }

  async function refresh() {
    setChecking(true);
    try { setScoring(await api('/api/scoring/status?refresh=1')); } catch (failure) { setError(failure.message); } finally { setChecking(false); }
  }
  useEffect(() => { if (status?.scoring) setScoring(status.scoring); }, [status?.scoring]);

  async function save(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    const body = { provider: form.provider, claudeCommand: form.claudeCommand, codexCommand: form.codexCommand, model: form.model.trim(), effort: form.effort,
      language: form.language, scoreMode: form.scoreMode, maxPerRun: Number(form.maxPerRun),
      ...(form.apiKey ? { apiKey: form.apiKey } : {}), ...(form.openaiApiKey ? { openaiApiKey: form.openaiApiKey } : {}) };
    try {
      await api('/api/settings', { method: 'PATCH', body: { ai: body } });
      setForm(current => ({ ...current, apiKey: '', openaiApiKey: '' }));
      await reload();
      await refresh();
      setMessage(t('已保存。', 'Saved.'));
    } catch (failure) { setError(failure.message); }
  }
  async function clearKey(key) {
    try { await api('/api/settings', { method: 'PATCH', body: { ai: { [key]: null } } }); await reload(); await refresh(); }
    catch (failure) { setError(failure.message); }
  }
  async function scoreAll() {
    setMessage('');
    try { await api('/api/scores', { method: 'POST', body: { limit: Number(form.maxPerRun) } }); setMessage(t('已开始给未打分的岗位打分。', 'Scoring the unscored jobs.')); }
    catch (failure) { setError(failure.message); }
  }

  const keyField = form.provider === 'anthropic-api'
    ? { key: 'apiKey', saved: ai.hasApiKey, env: ai.apiKeyFromEnv && 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-…' }
    : { key: 'openaiApiKey', saved: ai.hasOpenaiApiKey, env: ai.openaiKeyFromEnv && 'OPENAI_API_KEY', placeholder: 'sk-…' };
  const cliPath = form.provider === 'claude-cli'
    ? { key: 'claudeCommand', label: t('Claude Code 路径（可选）', 'Claude Code path (optional)'), find: 'claude', example: 'C:\\Users\\{you}\\.local\\bin\\claude.exe' }
    : { key: 'codexCommand', label: t('Codex 路径（可选）', 'Codex path (optional)'), find: 'codex', example: 'C:\\Users\\{you}\\AppData\\Roaming\\npm\\codex.cmd' };
  const modelValue = custom ? CUSTOM : form.model || provider.defaultModel;

  return (
    <form className="card-section" onSubmit={save}>
      <h2><Sparkles size={18} />{t('AI 打分', 'AI scoring')}</h2>
      <p className={`status-line ${scoring.available ? 'ok' : 'off'}`}>
        {scoring.available ? <CheckCircle2 size={15} /> : null}{serverText(scoring.detail)}
        <button type="button" className="icon-button" title={t('重新检测', 'Check again')} onClick={refresh} disabled={checking}>{checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}</button>
      </p>
      {PROVIDER_GROUPS.map(group => (
        <div key={group.name} className="provider-group">
          <h3 className="choice-title">{group.name}</h3>
          <div className="choice-row">
            {group.items.map(item => (
              <label key={item.id} className={form.provider === item.id ? 'selected' : ''}>
                <input type="radio" name="provider" checked={form.provider === item.id} onChange={() => chooseProvider(item.id)} />
                <strong>{t(...item.name)}</strong><span>{t(...item.detail)}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="form-grid">
        {usesKey ? (
          <label>{form.provider === 'anthropic-api' ? 'Anthropic API key' : 'OpenAI API key'}
            <input type="password" value={form[keyField.key]} onChange={event => set(keyField.key, event.target.value)} autoComplete="off"
              placeholder={keyField.saved ? t('已保存（输入新的可替换）', 'Saved (type a new one to replace it)') : keyField.env ? t(`使用环境变量 ${keyField.env}`, `Using ${keyField.env} from the environment`) : keyField.placeholder} />
            {keyField.saved ? <button type="button" className="link" onClick={() => clearKey(keyField.key)}>{t('清除已保存的 key', 'Remove the saved key')}</button>
              : <small>{t('只保存在本机数据库，不会显示回界面。', 'Stored only in the local database and never shown again.')}</small>}
          </label>
        ) : (
          <label>{cliPath.label}<input value={form[cliPath.key]} onChange={event => set(cliPath.key, event.target.value)} placeholder={t(`自动查找 ${cliPath.find}`, `Finds ${cliPath.find} automatically`)} maxLength={1024} />
            <small>{t(`找不到时填写，例如 ${cliPath.example.replace('{you}', '你')}`, `Fill in if it is not found, e.g. ${cliPath.example.replace('{you}', 'you')}`)}</small></label>
        )}
        <label>{t('模型', 'Model')}
          <select value={modelValue} onChange={event => chooseModel(event.target.value)}>
            {CLI_DEFAULT[form.provider] ? <option value="">{t(...CLI_DEFAULT[form.provider])}</option> : null}
            {provider.models.map(item => <option key={item.id} value={item.id}>{item.name}{item.tag ? ` · ${t(...MODEL_TAGS[item.tag])}` : ''}</option>)}
            <option value={CUSTOM}>{t('其他（输入模型 ID）', 'Other (type a model id)')}</option>
          </select>
          {custom ? <input value={form.model} onChange={event => set('model', event.target.value)} placeholder={provider.family === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol'}
            maxLength={100} aria-label={t('模型 ID', 'Model id')} autoFocus /> : null}
        </label>
        <label>{t('推理强度', 'Reasoning effort')}
          <select value={efforts.length ? form.effort : ''} onChange={event => set('effort', event.target.value)} disabled={!efforts.length}>
            <option value="">{efforts.length ? t('模型默认', 'Model default') : t('这个模型不支持', 'Not supported by this model')}</option>
            {efforts.map(level => <option key={level} value={level}>{t(...EFFORT_LABELS[level])}</option>)}
          </select>
          <small>{t('越高分析越细，但更慢、用量更多。', 'Higher looks closer, but is slower and uses more.')}</small>
        </label>
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
      <p className="hint">{t('每打一个岗位调用一次 AI，会用掉 Claude Code 或 Codex 的额度（或 API 费用）。选哪份简历是在本机比较关键词，不用额度。',
        'Each scored job is one AI call and uses your Claude Code or Codex allowance (or API credit). Choosing the resume is a keyword comparison on this computer and uses none.')}</p>
      {form.provider === 'codex-cli' ? <p className="hint">{t('ChatGPT Free 和 Go 方案在 Codex 里只能用 GPT-6 Luna；Plus、Pro、Business、Enterprise、Edu 可以用列表里的全部模型。没登录时，在终端运行 codex 并选择用 ChatGPT 登录。',
        'On ChatGPT Free and Go, Codex offers GPT-6 Luna only; Plus, Pro, Business, Enterprise and Edu get every model listed. To sign in, run codex in a terminal and choose Sign in with ChatGPT.')}</p> : null}
      {form.provider === 'anthropic-api' && model?.fallback ? <p className="hint">{t('使用 Claude API 时开启了服务器端回退：如果所选模型拒绝了某次请求，Anthropic 会自动换用备用模型重试一次。',
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

// 申请资料: what 自动填写 in the Dayjob browser puts into application forms.
const PROFILE_GROUPS = [
  { title: ['基本信息', 'About you'], fields: [
    ['firstName', '名', 'First name', 80], ['lastName', '姓', 'Last name', 80], ['preferredName', '常用名（可选）', 'Preferred name (optional)', 80],
    ['email', '邮箱', 'Email', 200, 'email'], ['phone', '电话', 'Phone', 40, 'tel'],
  ] },
  { title: ['地址', 'Address'], fields: [
    ['address', '街道地址', 'Street address', 200], ['city', '城市', 'City', 100], ['state', '州 / 省', 'State / province', 100],
    ['postalCode', '邮编', 'ZIP / postal code', 20], ['country', '国家', 'Country', 100],
  ] },
  { title: ['链接', 'Links'], fields: [['linkedin', 'LinkedIn', 'LinkedIn', 300, 'url'], ['github', 'GitHub', 'GitHub', 300, 'url'], ['website', '个人网站 / 作品集', 'Website / portfolio', 300, 'url']] },
  { title: ['教育', 'Education'], fields: [
    ['school', '学校', 'School', 160], ['degree', '学位', 'Degree', 100], ['major', '专业', 'Major', 160], ['graduation', '毕业时间', 'Graduation', 20],
  ] },
  { title: ['工作', 'Work'], fields: [
    ['company', '现在 / 最近的公司', 'Current or last company', 160], ['title', '职位', 'Job title', 160], ['yearsExperience', '工作年限', 'Years of experience', 10],
  ] },
  { title: ['常见问题', 'Common questions'], fields: [
    ['workAuthorized', '在岗位所在国家有工作许可', 'Authorized to work in the job’s country', 'yes-no'], ['needsSponsorship', '需要签证担保', 'Need visa sponsorship', 'yes-no'],
    ['willingToRelocate', '愿意搬迁', 'Willing to relocate', 'yes-no'], ['salary', '期望薪资', 'Expected salary', 100],
    ['startDate', '最早入职时间', 'Earliest start date', 100], ['heardFrom', '从哪里看到岗位（如 LinkedIn）', 'Where you found jobs (e.g. LinkedIn)', 100],
  ] },
];

function ApplicantProfile({ boot, reload, focused }) {
  const { t } = useI18n();
  const card = useRef(null);
  const [form, setForm] = useState(boot.settings.applicant);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { if (focused) card.current?.scrollIntoView({ block: 'start' }); }, [focused]);
  const set = (key, value) => { setForm(current => ({ ...current, [key]: value })); setMessage(''); };
  async function fromResume() {
    setError('');
    setMessage('');
    try {
      const found = await api('/api/applicant/from-resume');
      const empty = Object.entries(found).filter(([key, value]) => value && !String(form[key] || '').trim());
      setForm(current => ({ ...current, ...Object.fromEntries(empty) }));
      setMessage(empty.length ? t(`已从简历填入 ${empty.length} 项，检查后点保存。`, `Filled ${empty.length} fields from your resume. Check them, then save.`)
        : t('简历里没有找到还没填的联系方式。', 'Your resume has no contact details that are not already filled in.'));
    } catch (failure) { setError(serverText(failure.message)); }
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await api('/api/settings', { method: 'PATCH', body: { applicant: form } });
      setForm(saved.applicant);
      await reload();
      setMessage(t('已保存。', 'Saved.'));
    } catch (failure) { setError(serverText(failure.message)); } finally { setBusy(false); }
  }
  return (
    <form className="card-section" id="applicant" ref={card} onSubmit={save}>
      <h2><UserRound size={18} />{t('申请资料', 'Application profile')}</h2>
      <p className="hint">{t('在 Dayjob 浏览器里点“自动填写”时，Dayjob 按申请表上的问题把这些内容填进空着的格子。只保存在这台电脑上；上传简历、密码和提交前的检查始终由你来。',
        'When you click “Autofill” in the Dayjob browser, Dayjob puts these into the empty boxes of an application form by their questions. They stay on this computer; uploading your resume, passwords and the final check are always yours.')}</p>
      {PROFILE_GROUPS.map(group => (
        <fieldset key={group.title[0]} className="profile-group">
          <legend>{t(...group.title)}</legend>
          <div className="form-grid">
            {group.fields.map(([key, zh, en, rule, type]) => (
              <label key={key}>{t(zh, en)}
                {rule === 'yes-no' ? (
                  <select value={form[key]} onChange={event => set(key, event.target.value)}>
                    <option value="">{t('不填', 'Leave blank')}</option><option value="yes">{t('是', 'Yes')}</option><option value="no">{t('否', 'No')}</option>
                  </select>
                ) : <input type={type || 'text'} value={form[key]} maxLength={rule} onChange={event => set(key, event.target.value)} />}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <label className="profile-letter">{t('求职信（只填进求职信文本框）', 'Cover letter (only goes into cover-letter boxes)')}
        <textarea rows={4} maxLength={5000} value={form.coverLetter} onChange={event => set('coverLetter', event.target.value)} />
      </label>
      <label className="check"><input type="checkbox" checked={form.declineEeo} onChange={event => set('declineEeo', event.target.checked)} />
        {t('性别、种族、退伍军人、残障等自愿填写的问题，选“不愿透露”', 'Answer voluntary self-identification questions (gender, race, veteran, disability) with “decline to answer”')}</label>
      {error ? <p className="notice error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" onClick={fromResume} disabled={!boot.resumes.length}><FileUp size={15} />{t('从简历读取', 'Read from my resume')}</button>
        <button type="submit" className="button primary" disabled={busy}>{t('保存', 'Save')}</button>
      </div>
    </form>
  );
}

export function ResumeView({ boot, reload, status, focus }) {
  const { t } = useI18n();
  return (
    <section className="settings-page">
      <header className="view-header"><div><h1>{t('简历与 AI', 'Resume & AI')}</h1><p>{t('AI 会对照最匹配的那份简历给每个岗位打 0–100 分，并列出匹配点、差距和可补充的关键词。', 'AI rates each job 0–100 against your best-matching resume and lists strengths, gaps and keywords to add.')}</p></div></header>
      <Resumes resumes={boot.resumes} reload={reload} />
      <ApplicantProfile boot={boot} reload={reload} focused={focus === 'applicant'} />
      <AiSettings boot={boot} reload={reload} status={status} />
    </section>
  );
}
