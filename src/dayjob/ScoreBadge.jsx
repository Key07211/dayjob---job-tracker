import { useRef } from 'react';
import { label, scoreTone } from './format.js';
import { useI18n } from '../i18n.jsx';
import { CountUp } from './motion.js';

// "queued": waiting in a scoring batch. A score that arrives while the badge
// is on screen pops in and counts up.
export function ScoreBadge({ score, compact = false, queued = false, paused = false }) {
  const { t } = useI18n();
  const value = score?.score ?? null;
  const first = useRef(value);
  const landed = value !== null && first.current === null;
  const tone = scoreTone(value);
  if (value === null) {
    if (!compact) return null;
    const title = !queued ? t('还没有打分', 'Not scored yet') : paused ? t('打分已暂停，继续后会打分', 'Scoring is paused; it is scored once you resume') : t('排队打分中', 'Waiting to be scored');
    return <span className={`score-badge none${queued ? ` queued${paused ? ' held' : ''}` : ''}`} title={title}>—</span>;
  }
  return (
    <span className={`score-badge ${tone}${landed ? ' landed' : ''}`} title={label('verdict', score.verdict)}>
      <CountUp value={value} play={landed} />{compact ? null : <small>{label('verdict', score.verdict)}</small>}
    </span>
  );
}
