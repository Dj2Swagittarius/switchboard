// The app icon, drawn in code so there are no raster assets to keep in sync.
//
// Pure (no Electron), so both the running app (icon.mjs, via nativeImage) and
// the offline .ico generator share the exact same geometry. Returns a straight
// (non-premultiplied) RGBA buffer. DESIGN picks which switchboard mark to draw.
const ACCENT = [0x2f, 0x6d, 0xf6];   // #2f6df6
const DEEP = [0x1b, 0x46, 0xc0];     // a darker accent, for depth on the tile
const BADGE = [0xe8, 0x71, 0x0a];    // #e8710a  (tray "pending" dot)
const WHITE = [0xff, 0xff, 0xff];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const DESIGN = 'patchbay';    // 'headset' | 'patchbay' | 'operator'

const disc = (x, y, cx, cy, r) => clamp01(r - Math.hypot(x - cx, y - cy) + 0.5);

function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - (halfW - radius);
  const qy = Math.abs(y - cy) - (halfH - radius);
  const ex = Math.max(qx, 0), ey = Math.max(qy, 0);
  const d = Math.hypot(ex, ey) + Math.min(Math.max(qx, qy), 0) - radius;
  return clamp01(0.5 - d);
}

// Stroked circular arc (annulus), kept only where keep(x,y) holds.
function arc(x, y, cx, cy, r, thick, keep) {
  if (keep && !keep(x, y)) return 0;
  const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
  return clamp01(thick / 2 - d + 0.5);
}

// Stroked straight segment A->B of the given thickness (a patch cord).
function segment(x, y, ax, ay, bx, by, thick) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  let t = ((x - ax) * vx + (y - ay) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const d = Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
  return clamp01(thick / 2 - d + 0.5);
}

// ---- the three marks --------------------------------------------------------
// Each is a function (paint, S, c) that lays white (and some accent) over the
// already-painted tile. paint(color, coverage) composites top-down.

function headset(paint, pt, S, c) {
  const bandCy = 0.50 * S, bandR = 0.30 * S, bandT = 0.085 * S;
  const cupY = bandCy + 0.02 * S, cupDx = 0.30 * S;
  const boomR = 0.30 * S, boomT = 0.05 * S, micY = cupY + boomR;
  pt(WHITE, arc(pt.x, pt.y, c, bandCy, bandR, bandT, (px, py) => py <= bandCy + bandT));
  pt(WHITE, roundRect(pt.x, pt.y, c - cupDx, cupY, 0.085 * S, 0.145 * S, 0.06 * S));
  pt(WHITE, roundRect(pt.x, pt.y, c + cupDx, cupY, 0.085 * S, 0.145 * S, 0.06 * S));
  pt(WHITE, arc(pt.x, pt.y, c, cupY, boomR, boomT, (px, py) => px >= c - boomT && py >= cupY));
  pt(WHITE, disc(pt.x, pt.y, c, micY, 0.058 * S));
}

function patchbay(pt, _pt, S, c) {
  // Two rows of jack holes (white rings) with two patch cords plugged across.
  const x = pt.x, y = pt.y;
  const cols = [c - 0.26 * S, c, c + 0.26 * S];
  const rowTop = 0.33 * S, rowBot = 0.63 * S;
  const jackO = 0.082 * S, jackI = 0.040 * S;
  const ring = (jx, jy) => { pt(WHITE, disc(x, y, jx, jy, jackO)); pt(DEEP, disc(x, y, jx, jy, jackI)); };
  // Cords first (behind the plugs): top-left -> bottom-right, top-right -> bottom-mid.
  pt(WHITE, segment(x, y, cols[0], rowTop, cols[2], rowBot, 0.05 * S));
  pt(WHITE, segment(x, y, cols[2], rowTop, cols[1], rowBot, 0.05 * S));
  // Jack holes.
  for (const jx of cols) { ring(jx, rowTop); ring(jx, rowBot); }
  // Plug tips sitting in the four patched jacks.
  for (const [jx, jy] of [[cols[0], rowTop], [cols[2], rowBot], [cols[2], rowTop], [cols[1], rowBot]])
    pt(WHITE, disc(x, y, jx, jy, 0.046 * S));
}

function operator(paint, pt, S, c) {
  // Headset plus two call-signal arcs by the mic — "an operator on the line".
  headset(paint, pt, S, c);
  const sx = c + 0.30 * S, sy = 0.50 * S + 0.02 * S + 0.30 * S;   // near the mic tip
  pt(WHITE, arc(pt.x, pt.y, sx, sy, 0.085 * S, 0.03 * S, (px, py) => px >= sx));
  pt(WHITE, arc(pt.x, pt.y, sx, sy, 0.150 * S, 0.03 * S, (px, py) => px >= sx));
}

const MARKS = { headset, patchbay, operator };

export function iconRGBA(size, { badge = false, design = DESIGN } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const S = size;
  const draw = MARKS[design] || headset;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let rgb = [0, 0, 0], a = 0;
      const pt = (col, cov) => {
        if (cov <= 0) return;
        rgb = [rgb[0] * (1 - cov) + col[0] * cov, rgb[1] * (1 - cov) + col[1] * cov, rgb[2] * (1 - cov) + col[2] * cov];
        a = a + cov * (1 - a);
      };
      pt.x = x; pt.y = y;
      pt(ACCENT, roundRect(x, y, c, c, S * 0.46, S * 0.46, S * 0.26));
      draw(pt, pt, S, c);
      if (badge) pt(BADGE, disc(x, y, S * 0.80, S * 0.20, S * 0.22));

      const o = (y * S + x) * 4;
      buf[o] = Math.round(rgb[0]);
      buf[o + 1] = Math.round(rgb[1]);
      buf[o + 2] = Math.round(rgb[2]);
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
