// Dayjob's mark, the app icon in small (desktop/assets/icon-small.svg): four bars of a level meter on a tile, the
// third one lit. A fetch is a beat and each job found a bar, so the bars are what Dayjob does all day.
// [x, y, height] in the icon's 512 grid.
const BARS = [[70, 270, 150], [170, 170, 250], [270, 100, 320], [370, 220, 200]];
export function MarkGlyph({ className = '' }) {
  return (
    <svg className={`mark-glyph ${className}`} viewBox="0 0 512 512" aria-hidden="true">
      <rect className="mk-tile" width="512" height="512" rx="112" />
      {BARS.map(([x, y, height], i) => <rect key={x} className={`mk-bar${i === 2 ? ' peak' : ''}`} x={x} y={y} width="72" height={height} rx="24" />)}
    </svg>
  );
}
