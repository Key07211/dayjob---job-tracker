import { VERDICT_LABELS, scoreTone } from './format.js';

export function ScoreBadge({ score, compact = false }) {
  const value = score?.score ?? null;
  const tone = scoreTone(value);
  if (value === null) return compact ? <span className="score-badge none" title="还没有打分">—</span> : null;
  return (
    <span className={`score-badge ${tone}`} title={VERDICT_LABELS[score.verdict] || ''}>
      {value}{compact ? null : <small>{VERDICT_LABELS[score.verdict]}</small>}
    </span>
  );
}
