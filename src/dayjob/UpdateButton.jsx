import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import { useI18n } from '../i18n.jsx';
import { cue } from './groove/sound.js';

const updates = typeof window !== 'undefined' ? window.dayjobDesktop?.updates : null;
export const hasUpdates = Boolean(updates);

export function useUpdateState() {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!updates) return undefined;
    let live = true;
    updates.getState().then(value => { if (live) setState(value); }).catch(() => {});
    const stop = updates.onState(setState);
    return () => { live = false; stop(); };
  }, []);
  return state;
}

// Why an update has not been installed yet, in the interface language.
export function updateProblem(t, state) {
  if (state?.problem === 'in-use') {
    return t('Claude 正在通过 MCP 使用 Dayjob，Dayjob 没能关掉这个连接，安装文件还被占着。请先关闭 Claude Code（或在 Claude 的 /mcp 里断开 dayjob），再点“重启并更新”。',
      'Claude is using Dayjob over MCP and Dayjob could not stop that connection, so its files are still in use. Close Claude Code (or disconnect dayjob under /mcp in Claude), then click “Restart to update”.');
  }
  if (state?.problem === 'not-installed') {
    return t(`v${state.latest} 上次没有装上。点“重启并更新”再试一次；如果还不行，先关闭 Claude Code 再试。`,
      `Version ${state.latest} was not installed last time. Click “Restart to update” to try again; if it still fails, close Claude Code first.`);
  }
  return state?.error || '';
}

// Download progress drawn as a ring around the round button.
function Ring({ progress }) {
  const radius = 13;
  const length = 2 * Math.PI * radius;
  return (
    <svg className="update-ring" viewBox="0 0 30 30" aria-hidden="true">
      <circle cx="15" cy="15" r={radius} className="track" />
      <circle cx="15" cy="15" r={radius} className="bar" strokeDasharray={length} strokeDashoffset={length * (1 - (progress || 0) / 100)} />
    </svg>
  );
}

// The sidebar's update item: checks GitHub when clicked; when a newer version
// is out it turns into a round download button, then a restart button.
export function UpdateItem({ state }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  // Downloaded: one clear note as the button turns into "Restart to update" (fx.css pops it).
  const was = useRef(state?.status);
  useEffect(() => {
    if (state?.status === 'downloaded' && was.current === 'downloading') cue('done');
    was.current = state?.status;
  }, [state?.status]);
  if (!updates || !state) return null;
  const run = async work => {
    setBusy(true);
    try { await work(); } catch { /* the state event carries the error */ } finally { setBusy(false); }
  };
  const { status } = state;
  const version = `v${state.version}`;
  let icon = <RefreshCw size={18} />;
  let label = t('检查更新', 'Check for updates');
  let detail = version;
  let action = () => run(updates.check);
  let title = state.checkedAt ? t(`上次检查：${new Date(state.checkedAt).toLocaleString('zh-CN')}`, `Last checked ${new Date(state.checkedAt).toLocaleString('en-US')}`) : '';
  if (status === 'unsupported') {
    label = t('更新', 'Updates');
    action = null;
    title = t('开发版不检查更新。', 'Development builds do not check for updates.');
  } else if (status === 'checking') {
    icon = <LoaderCircle size={18} className="spin" />;
    label = t('正在检查…', 'Checking…');
    action = null;
  } else if (status === 'latest') {
    icon = <CheckCircle2 size={18} />;
    label = t('已是最新', 'Up to date');
  } else if (status === 'error') {
    icon = <AlertTriangle size={18} />;
    label = t('检查失败，点此重试', 'Check failed, retry');
    title = state.error || '';
  } else if (status === 'available') {
    icon = <span className="update-circle"><Download size={15} /></span>;
    label = t(`下载 v${state.latest}`, `Download v${state.latest}`);
    detail = state.problem ? t('没装上', 'Not installed') : state.error ? t('下载失败', 'Failed') : t('新版本', 'New');
    title = updateProblem(t, state) || (state.portable ? t('免安装版会在浏览器里下载新版本。', 'The portable app downloads the new version in your browser.') : t('下载后重启即可更新，数据会保留。', 'Download, then restart to update. Your data stays.'));
    action = () => run(updates.download);
  } else if (status === 'downloading') {
    icon = <span className="update-circle downloading"><Ring progress={state.progress} /><Download size={13} /></span>;
    label = t(`正在下载 ${state.progress ?? 0}%`, `Downloading ${state.progress ?? 0}%`);
    detail = '';
    action = null;
  } else if (status === 'downloaded') {
    icon = <span className="update-circle ready"><RotateCw size={15} /></span>;
    label = t('重启并更新', 'Restart to update');
    detail = state.problem ? t('没装上', 'Not installed') : `v${state.latest}`;
    title = updateProblem(t, state) || t('Dayjob 会关闭、安装新版本并重新打开。Claude 和 Dayjob 的连接会断开，更新后在 Claude 里重新连接即可。',
      'Dayjob closes, installs the new version and opens again. Claude’s connection to Dayjob drops; reconnect it in Claude afterwards.');
    action = () => run(updates.install);
  } else if (status === 'installing') {
    icon = <LoaderCircle size={18} className="spin" />;
    label = t('正在准备安装…', 'Preparing to install…');
    detail = '';
    action = null;
  }
  return (
    <button className={`nav-item update-item ${status}${state.problem ? ' problem' : ''}`} data-fx={['idle', 'latest', 'error'].includes(status) ? 'refresh' : status === 'available' ? 'pop' : undefined}
      onClick={action || undefined} disabled={!action || busy} title={title} aria-live="polite">
      {icon}<span>{label}</span>{detail ? <small>{detail}</small> : null}
    </button>
  );
}
