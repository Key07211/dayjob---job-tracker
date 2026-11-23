import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, FolderOpen, LoaderCircle, Paperclip, Star, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { formatTime } from './format.js';
import { useI18n } from '../i18n.jsx';
import { serverText } from './server-text.js';
import { cue } from './groove/sound.js';
import { leaveThen } from './groove/fx.js';

// 成绩单: the transcripts kept in Dayjob's transcript folder, as PDF files. An application form that asks for a
// transcript is given one of them; which one is told by the note beside it, or by the star. A PDF put into the
// folder by hand shows up here too.
const desktop = typeof window !== 'undefined' ? window.dayjobDesktop : undefined;

function toBase64(file, failed) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(failed));
    reader.readAsDataURL(file);
  });
}
const sizeText = bytes => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// The note on one transcript: what it is, in the user's words. Saved when the box is left or Enter is pressed.
function Note({ transcript, onSave }) {
  const { t } = useI18n();
  const [text, setText] = useState(transcript.note);
  useEffect(() => { setText(transcript.note); }, [transcript.note]);
  const save = () => { if (text.trim() !== transcript.note) onSave(text.trim()); };
  return (
    <input className="transcript-note" value={text} maxLength={80} aria-label={t('这份成绩单是什么', 'What this transcript is')}
      placeholder={t('备注：学校、学位，比如“UC Berkeley 硕士”', 'Note: school and degree, such as “UC Berkeley, master\'s”')}
      onChange={event => setText(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
  );
}

export function Transcripts({ reload = () => {} }) {
  const { t } = useI18n();
  const input = useRef(null);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => api('/api/transcripts').then(setState).catch(failure => setError(serverText(failure.message)));
  // The folder may have changed while the window was out of sight (a file put in by hand).
  useEffect(() => {
    void load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  const max = state?.max || 8;
  const maxBytes = state?.maxBytes || 20 * 1024 * 1024;
  const transcripts = state?.transcripts || [];
  const full = transcripts.length >= max;

  // Several files at once, one after the other. A file that is not taken is named with the reason.
  async function upload(chosen) {
    const files = [...(chosen || [])];
    if (input.current) input.current.value = '';
    if (!files.length) return;
    setError('');
    setBusy(true);
    const failed = [];
    let added = 0;
    for (const file of files) {
      if (file.size > maxBytes) { failed.push(`${file.name}: ${t(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`, `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`)}`); continue; }
      try {
        await api('/api/transcripts', { method: 'POST', body: { name: file.name, data: await toBase64(file, t('读取文件失败。', 'Could not read the file.')) } });
        added += 1;
      } catch (failure) { failed.push(files.length > 1 ? `${file.name}: ${serverText(failure.message)}` : serverText(failure.message)); }
    }
    await load();
    if (added) { cue('done'); void reload(); }
    if (failed.length) setError(failed.join('\n'));
    setBusy(false);
  }
  async function change(transcript, patch) {
    setError('');
    try { await api(`/api/transcripts/${transcript.id}`, { method: 'PATCH', body: patch }); await load(); void reload(); }
    catch (failure) { setError(serverText(failure.message)); }
  }
  function remove(transcript, row) {
    if (!window.confirm(t(`删除成绩单“${transcript.name}”？成绩单文件夹里它的文件也会删除。`, `Delete the transcript “${transcript.name}”? Its file in the transcript folder is deleted too.`))) return;
    leaveThen(row, 'shrink', async () => {
      try { await api(`/api/transcripts/${transcript.id}`, { method: 'DELETE' }); await load(); void reload(); return true; }
      catch (failure) { setError(serverText(failure.message)); return false; }
    });
  }

  return (
    <section className="card-section cover-letters transcripts" id="transcripts">
      <h2>{t(`成绩单（${transcripts.length}/${max}）`, `Transcripts (${transcripts.length}/${max})`)}</h2>
      <p className="hint">{t('把大学成绩单存成 PDF 放在这里。申请表里有“Transcript / 成绩单”上传栏时，自动填写和助手会把它附上去，文件由 Dayjob 直接放进网页，AI 只知道文件名和备注，看不到内容。有几份时，按备注里写的学校、学位和上传栏的要求对上；对不上就用打了星的那份，都没打星就用最新的一份。成绩单只保存在本机的成绩单文件夹里，直接把 PDF 放进那个文件夹也可以。',
        'Keep your university transcripts here as PDF files. When an application form has an upload for a transcript, autofill and the assistant attach one: Dayjob puts the file straight into the page, and the AI learns its file name and note, never what is in it. With several, the note (school, degree) is matched with what the upload asks for; when nothing matches, the starred one is used, or the newest when none has a star. Transcripts stay on this computer, in the transcript folder; putting a PDF into that folder yourself works too.')}</p>
      <input ref={input} type="file" hidden multiple accept=".pdf,application/pdf" onChange={event => upload(event.target.files)} />
      <ul className="resume-list">
        <li>
          <div>
            <strong>{transcripts.length ? t('再加一份', 'Add another') : t('还没有成绩单', 'No transcript yet')}</strong>
            <span>{t(`只收 PDF，每份不超过 ${Math.round(maxBytes / 1024 / 1024)} MB，可以一次选多个文件。`, `PDF only, up to ${Math.round(maxBytes / 1024 / 1024)} MB each; several files can be chosen at once.`)}</span>
          </div>
          <button className="button" data-fx="press" disabled={busy || full} title={full ? t('已经放满了，先删掉一份', 'The list is full: delete one first') : undefined} onClick={() => input.current?.click()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <FileUp size={15} />}{t('上传成绩单', 'Upload transcripts')}</button>
        </li>
        {transcripts.map(transcript => {
          const starred = transcript.isDefault;
          return (
            <li key={transcript.id}>
              <div>
                <strong>{transcript.name}</strong>
                <span className="resume-file"><Paperclip size={13} />{formatTime(transcript.addedAt)} · {sizeText(transcript.size)}
                  <a className="link" href={`/api/transcripts/${transcript.id}/file`} download={transcript.name}><Download size={13} />{t('下载', 'Download')}</a></span>
                <Note transcript={transcript} onSave={note => change(transcript, { note })} />
              </div>
              {transcripts.length > 1 ? (
                <button className={`icon-button transcript-star${starred ? ' on' : ''}`} aria-pressed={starred}
                  title={starred ? t('上传栏没说要哪一份时，用这一份。再点一下取消。', 'Used when an upload does not say which transcript it wants. Click again to take the star off.')
                    : t('设为默认：上传栏没说要哪一份时，用这一份', 'Make this the default: used when an upload does not say which transcript it wants')}
                  onClick={() => change(transcript, { isDefault: !transcript.isDefault })}><Star size={15} /></button>
              ) : null}
              <button className="icon-button" title={t('删除', 'Delete')} onClick={event => remove(transcript, event.currentTarget.closest('li'))}><Trash2 size={15} /></button>
            </li>
          );
        })}
      </ul>
      {error ? <p className="notice error">{error}</p> : null}
      {desktop?.openDataFolder && state?.folder ? (
        <button type="button" className="button" data-fx="folder" onClick={() => desktop.openDataFolder('transcripts').catch(failure => setError(failure.message))}><FolderOpen size={15} />{t('打开成绩单文件夹', 'Open the transcript folder')}</button>
      ) : null}
    </section>
  );
}
