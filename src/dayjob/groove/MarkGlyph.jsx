// Dayjob's mark, the app icon (desktop/assets/icon.svg): an open briefcase, and in it a record player tilted back 45°,
// a short level meter and a note rising above the record. The job hunt on the outside, the music on the inside.
// [x, height] of the meter's bars in the icon's 512 grid; they stand on y 238.
const METER = [[176, 34], [206, 58], [236, 44], [266, 26]];
export function MarkGlyph({ className = '' }) {
  return (
    <svg className={`mark-glyph ${className}`} viewBox="0 0 512 512" aria-hidden="true">
      <rect className="mk-tile" width="512" height="512" rx="112" />
      <g className="mk-body">
        <path className="mk-handle" d="M198 136V112a26 26 0 0 1 26-26h64a26 26 0 0 1 26 26v24" />
        <rect className="mk-case" x="58" y="128" width="396" height="310" rx="50" />
        <rect className="mk-inside" x="86" y="156" width="340" height="254" rx="30" />
        <rect className="mk-side" x="99" y="374" width="314" height="24" rx="10" />
        <path className="mk-deck" d="M136 258H376L404 374H108Z" />
        <ellipse className="mk-disc" cx="234" cy="318" rx="94" ry="54" />
        <ellipse className="mk-groove" cx="234" cy="318" rx="72" ry="40" />
        <ellipse className="mk-groove" cx="234" cy="318" rx="51" ry="28" />
        <ellipse className="mk-label" cx="234" cy="318" rx="25" ry="14" />
        <path className="mk-arm" d="M366 282L360 328L322 342" />
        <circle className="mk-pivot" cx="366" cy="282" r="13" />
      </g>
      {METER.map(([x, height]) => <rect key={x} className="mk-bar" x={x} y={238 - height} width="20" height={height} rx="10" />)}
      <g className="mk-note">
        <ellipse cx="322" cy="230" rx="13.3" ry="10" transform="rotate(-22 322 230)" />
        <rect x="328.6" y="178.7" width="7.6" height="51.3" rx="3.8" />
        <path d="M332.4 178.7q3.8 13.3 20.9 19q5.7 3.8 1.9 15.2" />
      </g>
    </svg>
  );
}

// The loading meter: four bars, the third one lit.
const BARS = [[70, 270, 150], [170, 170, 250], [270, 100, 320], [370, 220, 200]];
export function MeterGlyph() {
  return (
    <svg className="meter-glyph" viewBox="0 0 512 512" aria-hidden="true">
      {BARS.map(([x, y, height], i) => <rect key={x} className={`mk-bar${i === 2 ? ' peak' : ''}`} x={x} y={y} width="72" height={height} rx="24" />)}
    </svg>
  );
}
