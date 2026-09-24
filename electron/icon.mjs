// Draws the app icon in code, so there are no image assets to ship.
// A blue disc with a white dot; the pending variant adds an amber badge.
import { nativeImage } from 'electron';

const ACCENT = [0x2f, 0x6d, 0xf6];   // #2f6df6
const BADGE = [0xe8, 0x71, 0x0a];    // #e8710a
const WHITE = [0xff, 0xff, 0xff];

// Coverage of a disc at (cx, cy) radius r for the pixel centred at (x, y),
// with a one-pixel soft edge for anti-aliasing.
const disc = (x, y, cx, cy, r) =>
  Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));

function draw(size, { badge = false } = {}) {
  // Electron expects BGRA with premultiplied alpha.
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const R = size / 2 - 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rgb = [0, 0, 0], a = 0;
      const paint = (col, cov) => {
        if (cov <= 0) return;
        rgb = rgb.map((v, i) => v * (1 - cov) + col[i] * cov);
        a = a + cov * (1 - a);
      };
      paint(ACCENT, disc(x, y, c, c, R));
      paint(WHITE, disc(x, y, c, c, R * 0.34));
      if (badge) paint(BADGE, disc(x, y, size * 0.78, size * 0.22, size * 0.22));

      const o = (y * size + x) * 4;
      buf[o] = Math.round(rgb[2] * a);
      buf[o + 1] = Math.round(rgb[1] * a);
      buf[o + 2] = Math.round(rgb[0] * a);
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export const appIcon = () => draw(256);
export const trayIcon = (pending = 0) => draw(32, { badge: pending > 0 });

// A Windows .ico holding PNG images at the sizes Explorer asks for, so the
// desktop shortcut is sharp at every icon size.
export function appIco() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map(size => ({ size, buf: draw(size).toPNG() }));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);             // reserved
  head.writeUInt16LE(1, 2);             // type: icon
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = head.length + dir.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o);       // 0 means 256
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    dir.writeUInt16LE(1, o + 4);                          // colour planes
    dir.writeUInt16LE(32, o + 6);                         // bits per pixel
    dir.writeUInt32LE(p.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.buf.length;
  });
  return Buffer.concat([head, dir, ...pngs.map(p => p.buf)]);
}
