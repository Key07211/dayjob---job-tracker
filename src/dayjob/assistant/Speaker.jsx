// The assistant's face: a small loudspeaker. It only moves while something is happening.
//   idle      still
//   thinking  the cone trembles
//   speaking  the cone pumps on the beat and rings of sound leave it
//   tool      one thump, as the note for the page it is working on flies off (see flyTo in main.jsx)
// Colours come from the theme: pale blue with a warm yellow cap by day, brown-grey with the desk-lamp yellow at night.
export function Speaker({ phase = 'idle', size = 44, label }) {
  return (
    <span className={`speaker ${phase}`} style={{ width: size, height: size * 1.25 }} role="img" aria-label={label}>
      <svg viewBox="0 0 96 120" aria-hidden="true">
        <rect className="sp-foot" x="20" y="112" width="14" height="6" rx="2" />
        <rect className="sp-foot" x="62" y="112" width="14" height="6" rx="2" />
        <rect className="sp-cabinet" x="8" y="4" width="80" height="110" rx="16" />
        <circle className="sp-ring r1" cx="48" cy="74" r="22" />
        <circle className="sp-ring r2" cx="48" cy="74" r="22" />
        <g className="sp-tweeter">
          <circle className="sp-surround" cx="48" cy="27" r="10" />
          <circle className="sp-cap" cx="48" cy="27" r="4.5" />
        </g>
        <circle className="sp-lamp" cx="48" cy="45" r="2.4" />
        <circle className="sp-surround" cx="48" cy="74" r="28" />
        <g className="sp-cone">
          <circle className="sp-paper" cx="48" cy="74" r="21" />
          <circle className="sp-groove" cx="48" cy="74" r="14" />
          <circle className="sp-cap" cx="48" cy="74" r="8" />
        </g>
      </svg>
    </span>
  );
}
