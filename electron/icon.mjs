// The app icon for the running app (window, tray, taskbar, notifications).
// The pixels come from icon-draw.mjs (pure, shared with the offline .ico
// generator); here they're wrapped for Electron. The tray "pending" variant
// adds an amber badge.
import { nativeImage } from 'electron';
import { iconRGBA, ICO_SIZES } from './icon-draw.mjs';

function draw(size, opts = {}) {
  const rgba = iconRGBA(size, opts);
  // Electron wants premultiplied BGRA.
  const bgra = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    bgra[i] = Math.round(rgba[i + 2] * a);
    bgra[i + 1] = Math.round(rgba[i + 1] * a);
    bgra[i + 2] = Math.round(rgba[i] * a);
    bgra[i + 3] = rgba[i + 3];
  }
  return nativeImage.createFromBitmap(bgra, { width: size, height: size });
}

export const appIcon = () => draw(256);
export const trayIcon = (pending = 0) => draw(32, { badge: pending > 0 });

// A Windows .ico holding PNG images at the sizes Explorer asks for, so the
// desktop shortcut is sharp at every icon size.
export function appIco() {
  const pngs = ICO_SIZES.map((size) => ({ size, buf: draw(size).toPNG() }));
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
  return Buffer.concat([head, dir, ...pngs.map((p) => p.buf)]);
}
