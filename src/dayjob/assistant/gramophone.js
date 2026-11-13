// The assistant's face: a pixel gramophone, painted from a few shapes on a small grid so that the horn can grow and
// shrink one pixel at a time. Everything here is in sprite pixels and knows nothing about the page; Gramophone.jsx
// enlarges the result by a whole number of screen pixels, without smoothing.
export const W = 42, H = 40;           // one frame, with room around the drawing for the horn to grow
export const OX = 4, OY = 6;           // where the 32 x 32 drawing sits inside the frame
export const COLORS = [null,
  '#2a1a0e',                                                         // 1 outline
  '#6b4818', '#a37426', '#d19c3a', '#efc962', '#fff0ad',             // 2-6 brass, dark to light
  '#3f2317', '#633821', '#86502e', '#ad7443',                        // 7-10 wood, dark to light
  '#161311', '#2e2926', '#6f665e',                                   // 11-13 record
  '#f4c95d', '#b98a2c',                                              // 14-15 label
];
const O = 1, B1 = 2, B2 = 3, B3 = 4, B4 = 5, B5 = 6, W1 = 7, W2 = 8, W3 = 9, W4 = 10, K0 = 11, K1 = 12, K2 = 13, Y = 14, YD = 15;
export const AX = 0.82, AY = -0.57;    // the way the horn faces: up and to the right
const MX = 0.57, MY = 0.82;     // across the mouth
const BELL = { cx: 20, cy: 7.6, major: 9.6, minor: 7.1 };
const ELBOW = { x: 11, y: 14.6 };

// Where the horn's mouth is for a given size step (-1 pulled in, 0 at rest, 1 and 2 pushed out).
export function mouth(grow) {
  return { cx: BELL.cx + AX * grow * 0.6, cy: BELL.cy + AY * grow * 0.6, major: BELL.major + grow, minor: BELL.minor + grow * 0.8 };
}

// One frame, as colour numbers (0 is see-through): grow is the horn's size step, spin where the record's glints are
// (0 to 7), crank the handle's position (0 to 3, or -1 at rest).
export function frame(grow = 0, spin = 0, crank = -1) {
  const px = new Uint8Array(W * H);
  const set = (x, y, c) => { x += OX; y += OY; if (x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = c; };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) set(x, y, c); };

  // ---- the box ----
  rect(8, 23, 26, 29, W2);
  rect(8, 23, 26, 23, W1);                    // the shadow under the lid
  rect(8, 24, 9, 29, W3);                     // the lit side
  rect(25, 24, 26, 29, W1);                   // the side in shade
  rect(8, 29, 26, 29, W1);
  rect(7, 21, 27, 21, W3);                    // the lid, seen a little from above
  rect(7, 22, 27, 22, W4);                    // its front edge
  rect(7, 30, 27, 30, W3);                    // the plinth
  rect(8, 31, 10, 31, W1); rect(24, 31, 26, 31, W1);   // feet
  // The carving on the front: a small diamond with a dot at each side.
  for (const [x, y] of [[17, 24], [16, 25], [18, 25], [15, 26], [17, 26], [19, 26], [16, 27], [18, 27], [17, 28], [12, 26], [22, 26]]) set(x, y, W4);

  // ---- the crank at the side (only drawn turning while the assistant is at work) ----
  set(27, 25, B2);
  const arm = [[[28, 24], [28, 23]], [[28, 25], [29, 25]], [[28, 26], [28, 27]], [[28, 25], [28, 25]]][crank < 0 ? 2 : crank % 4];
  set(arm[0][0], arm[0][1], B3); set(arm[1][0], arm[1][1], B4);

  // ---- the neck that comes up out of the lid ----
  rect(10, 15, 10, 20, B4); rect(11, 15, 11, 20, B2);
  rect(9, 20, 12, 20, B3);                    // collar

  // ---- the record ----
  const rc = { x: 18, y: 20 };
  for (let y = 19; y <= 21; y += 1) for (let x = 9; x <= 27; x += 1) {
    const dx = (x + 0.5 - rc.x - 0.5) / 8.2, dy = (y - rc.y) / 1.5;
    if (dx * dx + dy * dy <= 1) set(x, y, Math.abs(y - rc.y) + Math.abs(x - rc.x) / 6 > 1.6 ? K1 : K0);
  }
  set(17, 20, Y); set(18, 20, Y); set(19, 20, YD);
  // Two glints that travel round the record as it turns.
  const turn = (spin % 8) * Math.PI / 4;
  for (const side of [0, Math.PI]) {
    const gx = Math.round(rc.x + Math.cos(turn + side) * 5.6), gy = Math.round(rc.y + Math.sin(turn + side) * 1.05);
    set(gx, gy, K2);
  }
  // The arm with its needle, resting on the record.
  set(12, 19, B3); set(13, 19, B2); set(14, 20, B4);

  // ---- the horn: a flared body, then the mouth on top of it ----
  const m = mouth(grow);
  const lenX = m.cx - ELBOW.x, lenY = m.cy - ELBOW.y, len2 = lenX * lenX + lenY * lenY, len = Math.sqrt(len2);
  const throat = { x: m.cx - AX * m.minor * 0.38, y: m.cy - AY * m.minor * 0.38 };
  const under = px.slice();
  const horn = new Uint8Array(W * H);
  const paint = (x, y, c) => { set(x, y, c); const at = (y + OY) * W + x + OX; if (x + OX >= 0 && y + OY >= 0 && x + OX < W && y + OY < H) horn[at] = 1; };
  for (let y = -6; y < 26; y += 1) for (let x = -4; x < 38; x += 1) {
    const cx = x + 0.5, cy = y + 0.5;
    // the body
    const s = ((cx - ELBOW.x) * lenX + (cy - ELBOW.y) * lenY) / len2;
    if (s >= -0.08 && s <= 1) {
      const side = ((cx - ELBOW.x) * lenY - (cy - ELBOW.y) * lenX) / len;      // > 0 on the upper left of the axis
      const radius = 1.25 + (m.major - 1.25) * Math.max(0, s) ** 2.4;
      if (Math.abs(side) <= radius) { const q = side / radius; paint(x, y, q > 0.3 ? B4 : q < -0.35 ? B1 : B2); }
    }
    // the mouth
    const dx = cx - m.cx, dy = cy - m.cy;
    const u = dx * MX + dy * MY, v = dx * AX + dy * AY;
    const e = Math.sqrt((u / m.major) ** 2 + (v / m.minor) ** 2);
    if (e > 1) continue;
    const rim = Math.sqrt((u / (m.major - 1.15)) ** 2 + (v / (m.minor - 1.15)) ** 2) > 1;
    if (rim) {
      const lit = (-dx * 0.6 - dy * 0.8) / Math.hypot(dx, dy);
      paint(x, y, lit > 0.2 ? B5 : lit > -0.45 ? B4 : B3);
      continue;
    }
    const tx = cx - throat.x, ty = cy - throat.y;
    const deep = Math.hypot(tx, ty) / ((m.major + m.minor) / 2);
    let shade = deep < 0.17 ? O : deep < 0.34 ? B1 : deep < 0.66 ? B2 : deep < 1.02 ? B3 : B4;
    // Petals: every other slice round the throat is one step darker, as on a morning-glory horn.
    const slice = Math.floor((Math.atan2(ty, tx) + Math.PI) / (Math.PI * 2 / 10));
    if (slice % 2 && shade > B1 && shade !== O) shade -= 1;
    paint(x, y, shade);
  }
  // A lone pixel sticking out of the horn's edge is taken off, so the outline stays smooth as it grows.
  for (let y = 1; y < H - 1; y += 1) for (let x = 1; x < W - 1; x += 1) {
    const at = y * W + x;
    if (!horn[at]) continue;
    const around = (px[at - 1] ? 1 : 0) + (px[at + 1] ? 1 : 0) + (px[at - W] ? 1 : 0) + (px[at + W] ? 1 : 0);
    if (around < 2) px[at] = under[at];
  }
  // the elbow where neck and horn meet
  set(10, 14, B4); set(11, 14, B3); set(10, 13, B4); set(11, 13, B3); set(12, 14, B2);

  // ---- a dark line round the whole thing ----
  const out = px.slice();
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    if (px[y * W + x]) continue;
    if ((x > 0 && px[y * W + x - 1]) || (x < W - 1 && px[y * W + x + 1]) || (y > 0 && px[(y - 1) * W + x]) || (y < H - 1 && px[(y + 1) * W + x])) out[y * W + x] = O;
  }
  return out;
}

// Notes, as little bitmaps.
export const NOTES = [
  ['..#..', '..##.', '..#.#', '..#..', '###..', '###..'],
  ['.######', '.#....#', '.#....#', '.#....#', '##...##', '##...##'],
  ['..#', '..#', '..#', '###', '###'],
  ['..##.', '..#.#', '..#..', '###..', '###..'],
].map(rows => ({ w: rows[0].length, h: rows.length, on: rows.map(row => [...row].map(ch => ch === '#')) }));
// An ordered-dither table: a note goes away a few pixels at a time instead of turning see-through.
export const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
