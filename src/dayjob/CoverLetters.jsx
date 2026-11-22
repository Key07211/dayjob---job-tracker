import { useEffect, useRef, useState } from 'react';
import { Download, FileText, FileUp, FolderOpen, LoaderCircle, Paperclip, PenLine, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { formatTime } from './format.js';
import { useI18n } from '../i18n.jsx';
import { serverText } from './server-text.js';
import { cue } from './groove/sound.js';
import { leaveThen } from './groove/fx.js';
import { assistant, onAssistantEffect } from './assistant/store.js';

// 求职信: the samples the assistant writes from, and the letters it has written, one for each job. A letter's
// file is in Dayjob's cover letter folder on this computer; the desktop app opens it, a browser downloads it.
const desktop = typeof window !== 'undefined' ? window.dayjobDesktop : undefined;
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';

function toBase64(file, failed) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(failed));
    reader.readAsDataURL(file);
  });
}

// What the assistant is asked, in the user's language; the id lets it find the posting without asking which.
const request = (posting, t) => t(`为这个岗位写一封求职信，写好后存进求职信文件夹：${[posting.company, posting.title].filter(Boolean).join(' · ')}（岗位 id：${posting.id}）`,
  `Write a cover letter for this job and save it in the cover letter folder: ${[posting.company, posting.title].filter(Boolean).join(' · ')} (posting id: ${posting.id})`);

// A letter's file: opened by the desktop app, downloaded anywhere else.
function OpenLetter({ letter, onError, className = 'link', children }) {
  if (desktop?.openCoverLetter) {
    return <button type="button" className={className} data-fx="open" onClick={() => desktop.openCoverLetter(letter.id).catch(failure => onError(failure.message))}>{children}</button>;
  }
  return <a className={className} href={`/api/cover-letters/${letter.id}/file`} download={letter.file || undefined}>{children}</a>;
}

// In a job's details, among its actions: has the assistant write the letter, or opens the one it wrote.
export function LetterButton({ posting, letter, onError = () => {} }) {
  const { t } = useI18n();
  const write = () => { onError(''); void assistant.write(request(posting, t)); };
  if (!letter) {
    return <button type="button" className="button" data-fx="press" onClick={write} title={t('助手按你的简历和求职信样本为这个岗位写一封求职信，存进求职信文件夹', 'The assistant writes a cover letter for this job from your resume and your sample letters, and keeps it in the cover letter folder')}><PenLine size={15} />{t('写求职信', 'Write cover letter')}</button>;
  }
  return (
    <>
      {letter.hasFile ? <OpenLetter letter={letter} onError={onError} className="button"><FileText size={15} />{t('打开求职信', 'Open cover letter')}</OpenLetter> : null}
      <button type="button" className={letter.hasFile ? 'icon-button' : 'button'} onClick={write} title={t('让助手重写这封求职信', 'Have the assistant write this letter again')}>
        <RefreshCw size={15} />{letter.hasFile ? null : t('重写求职信', 'Rewrite cover letter')}</button>
    </>
  );
}

// On the Resume & AI page: the samples and the letters.
export function CoverLetters() {
  const { t } = useI18n();
  const input = useRef(null);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [texts, setTexts] = useState({});
  const load = () => api('/api/cover-letters').then(setState).catch(failure => setError(serverText(failure.message)));
  useEffect(() => { void load(); }, []);
  // The assistant saved or replaced a letter: the list follows.
  useEffect(() => onAssistantEffect(({ changed }) => { if (changed) { setTexts({}); void load(); } }), []);

  // Several files at once, one after the other. A file that cannot be read is named with the reason; the others
  // are still added.
  async function upload(chosen) {
    const files = [...(chosen || [])];
    if (input.current) input.current.value = '';
    if (!files.length) return;
    setError('');
    setBusy(true);
    const failed = [];
    let added = 0;
    for (const file of files) {
      if (file.size > MAX_BYTES) { failed.push(`${file.name}: ${t('文件超过 8 MB。', 'The file is larger than 8 MB.')}`); continue; }
      try {
        await api('/api/cover-letters/samples', { method: 'POST', body: { name: file.name, mime: file.type, data: await toBase64(file, t('读取文件失败。', 'Could not read the file.')) } });
        added += 1;
      } catch (failure) { failed.push(files.length > 1 ? `${file.name}: ${serverText(failure.message)}` : serverText(failure.message)); }
    }
    await load();
    if (added) cue('done');
    if (failed.length) setError(failed.join('\n'));
    setBusy(false);
  }
  function removeSample(sample, row) {
    if (!window.confirm(t(`删除样本“${sample.name || '求职信样本'}”？已经写好的求职信不受影响。`, `Delete the sample “${sample.name || 'cover letter sample'}”? Letters already written stay as they are.`))) return;
    leaveThen(row, 'shrink', async () => {
      try { await api(`/api/cover-letters/samples/${sample.id}`, { method: 'DELETE' }); await load(); return true; }
      catch (failure) { setError(serverText(failure.message)); return false; }
    });
  }
  function remove(letter, row) {
    const job = [letter.company, letter.title].filter(Boolean).join(' · ');
    if (!window.confirm(t(`删除“${job}”的求职信？文件夹里它的文件也会删除。`, `Delete the cover letter for “${job}”? Its file in the folder is deleted too.`))) return;
    leaveThen(row, 'shrink', async () => {
      try { await api(`/api/cover-letters/${letter.id}`, { method: 'DELETE' }); await load(); return true; }
      catch (failure) { setError(serverText(failure.message)); return false; }
    });
  }
  // The letter's words, fetched when its row is unfolded.
  function read(letter, open) {
    if (!open || texts[letter.id] !== undefined) return;
    api(`/api/cover-letters/${letter.id}`).then(full => setTexts(now => ({ ...now, [letter.id]: full.text }))).catch(failure => setError(serverText(failure.message)));
  }

  const samples = state?.samples || [];
  const full = samples.length >= (state?.maxSamples || 8);
  const letters = state?.letters || [];
  return (
    <section className="card-section cover-letters">
      <h2>{t(`求职信（${letters.length}）`, `Cover letters (${letters.length})`)}</h2>
      <p className="hint">{t('上传几封你自己写过的求职信做样本，可以一次选多个文件。之后在岗位详情里点“写求职信”，或者直接跟助手说“给这个岗位写求职信”：助手读你的简历和全部样本，从里面挑出和岗位最对得上的经历和例子，合在一起，按样本的结构和语气写好，存成 PDF 放进求职信文件夹。每个岗位一封，重写会替换旧的。样本和求职信都只保存在本机。',
        'Upload a few cover letters you have written as samples; several files can be chosen at once. Then press “Write cover letter” in a job\'s details, or just ask the assistant: it reads your resume and all the samples, picks the experiences and examples that fit the job best, puts them together, writes the letter in the samples\' structure and tone, and keeps it as a PDF in the cover letter folder. One letter a job; writing it again replaces it. The samples and the letters stay on this computer.')}</p>
      <input ref={input} type="file" hidden multiple accept={TYPES} onChange={event => upload(event.target.files)} />
      <ul className="resume-list">
        <li>
          <div>
            <strong>{t(`样本（${samples.length} / ${state?.maxSamples || 8}）`, `Samples (${samples.length} / ${state?.maxSamples || 8})`)}</strong>
            <span>{samples.length ? t('助手写信时会把这些样本都读一遍。支持 PDF、Word（.docx）和纯文本。', 'The assistant reads all of these when it writes a letter. PDF, Word (.docx) or plain text.')
              : t('还没有样本。没有样本时，助手按常见的求职信格式写。支持 PDF、Word（.docx）和纯文本。', 'No samples yet. Without them the assistant writes a letter in a plain, standard form. PDF, Word (.docx) or plain text.')}</span>
          </div>
          <button className="button" data-fx="press" disabled={busy || full} title={full ? t('样本已满，先删掉一份', 'The list is full: delete a sample first') : undefined} onClick={() => input.current?.click()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <FileUp size={15} />}{t('上传样本', 'Upload samples')}</button>
        </li>
        {samples.map(sample => (
          <li key={sample.id} className="letter-sample">
            <div>
              <strong>{sample.name || t('求职信样本', 'Cover letter sample')}</strong>
              <span>{formatTime(sample.createdAt)} · {t(`${sample.characters.toLocaleString()} 字符`, `${sample.characters.toLocaleString()} characters`)}</span>
              <details className="resume-preview"><summary>{t('查看读出的文字（前 600 字）', 'Show the text that was read (first 600 characters)')}</summary><pre>{sample.preview}</pre></details>
            </div>
            <button className="icon-button" title={t('删除这份样本', 'Delete this sample')} onClick={event => removeSample(sample, event.currentTarget.closest('li'))}><Trash2 size={15} /></button>
          </li>
        ))}
        {letters.map(letter => (
          <li key={letter.id}>
            <div>
              <strong>{[letter.company, letter.title].filter(Boolean).join(' · ') || t('（没有岗位名）', '(no job name)')}</strong>
              <span>{formatTime(letter.updatedAt)} · {t(`${letter.characters.toLocaleString()} 字符`, `${letter.characters.toLocaleString()} characters`)}</span>
              {letter.hasFile ? (
                <span className="resume-file"><Paperclip size={13} />{letter.file}
                  <OpenLetter letter={letter} onError={setError}>{desktop?.openCoverLetter ? <FileText size={13} /> : <Download size={13} />}{desktop?.openCoverLetter ? t('打开', 'Open') : t('下载', 'Download')}</OpenLetter></span>
              ) : <span className="resume-file missing">{t('文件夹里已经没有它的文件了，文字还在。让助手重写一次会重新生成文件。', 'Its file is no longer in the folder; the text is still here. Having the assistant write it again makes a new file.')}</span>}
              <details className="resume-preview" onToggle={event => read(letter, event.currentTarget.open)}><summary>{t('查看全文', 'Show the letter')}</summary><pre>{texts[letter.id] ?? t('读取中…', 'Loading…')}</pre></details>
            </div>
            <button className="icon-button" title={t('删除', 'Delete')} onClick={event => remove(letter, event.currentTarget.closest('li'))}><Trash2 size={15} /></button>
          </li>
        ))}
      </ul>
      {error ? <p className="notice error">{error}</p> : null}
      {desktop?.openDataFolder && state?.folder ? (
        <button type="button" className="button" data-fx="folder" onClick={() => desktop.openDataFolder('cover-letters').catch(failure => setError(failure.message))}><FolderOpen size={15} />{t('打开求职信文件夹', 'Open the cover letter folder')}</button>
      ) : null}
    </section>
  );
}
