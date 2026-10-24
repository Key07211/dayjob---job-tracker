import { label, scoreTone } from './format.js';
import { useI18n } from '../i18n.jsx';

export function ScoreBadge({ score, compact = false, landed = false }) {
  const { t } = useI18n();
  const value = score?.score ?? null;
  const tone = scoreTone(value);
  if (value === null) return compact ? <span className="score-badge none" title={t('还没有打分', 'Not scored yet')}>—</span> : null;
  return (
    <span key={landed ? `landed-${value}` : 'still'} className={`score-badge ${tone}${landed ? ' landed' : ''}`} title={label('verdict', score.verdict)}>
      {value}{compact ? null : <small>{label('verdict', score.verdict)}</small>}
    </span>
  );
}
