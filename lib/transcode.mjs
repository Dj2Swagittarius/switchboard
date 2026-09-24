// Makes MMS video and voice memos playable in the app.
//
// Phones send 3GPP files with H.264 video (Chromium plays it) and AMR-NB
// audio (Chromium can't), so they play silently. With ffmpeg on this PC the
// audio is converted to AAC and the video stream copied untouched; without it
// the original is served and the caller is told the sound won't play.
//
// MMS media comes from anyone, so ffmpeg is fenced in: the input format is
// forced (never probed), only the file protocol is allowed, it runs without a
// window or stdin, and is killed after a time limit. It only runs when someone
// presses play (see /api/media?play=1), never when a thread is opened.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';
const TIMEOUT_MS = 30e3;
const MAX_IN = 60 * 1024 * 1024;

let available = null;
export function hasFfmpeg() {
  if (available !== null) return Promise.resolve(available);
  return new Promise((resolve) => {
    let p;
    try { p = spawn(FFMPEG(), ['-hide_banner', '-version'], { windowsHide: true, stdio: 'ignore' }); }
    catch { available = false; return resolve(false); }
    p.on('error', () => { available = false; resolve(false); });
    p.on('close', (code) => { available = code === 0; resolve(available); });
  });
}

// Sample-entry codes in an ISO-BMFF (MP4/3GP) file, e.g. ['avc1', 'samr'].
export function codecs(buf) {
  const out = [];
  const boxes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const walk = (off, end, depth) => {
    while (depth < 8 && off + 8 <= end) {
      let size = buf.readUInt32BE(off), hdr = 8;
      const type = buf.toString('latin1', off + 4, off + 8);
      if (size === 1 && off + 16 <= end) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; }
      else if (size === 0) size = end - off;
      if (size < hdr || off + size > end) return;
      if (type === 'stsd' && off + hdr + 8 <= end) {
        const n = Math.min(buf.readUInt32BE(off + hdr + 4), 8);
        let e = off + hdr + 8;
        for (let i = 0; i < n && e + 8 <= off + size; i++) {
          out.push(buf.toString('latin1', e + 4, e + 8));
          const es = buf.readUInt32BE(e);
          if (es < 8) break;
          e += es;
        }
      }
      if (boxes.has(type)) walk(off + hdr, off + size, depth + 1);
      off += size;
    }
  };
  try { walk(0, buf.length, 0); } catch {}
  return out;
}

const AMR = new Set(['samr', 'sawb']);
const isIsoBmff = (buf) => buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp';
const isRawAmr = (buf) => buf.toString('latin1', 0, 6) === '#!AMR\n' || buf.toString('latin1', 0, 9) === '#!AMR-WB\n';

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const t = setTimeout(() => { p.kill(); reject(new Error('conversion took too long')); }, TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.split('\n').filter(Boolean).pop())); });
  });
}

// { buf, type } -> { buf, type, audio: 'ok' | 'unsupported' }. Anything this
// doesn't need to touch comes back as it was.
export async function playable({ buf, type }) {
  const video = isIsoBmff(buf);
  const needs = video ? codecs(buf).some(c => AMR.has(c)) : isRawAmr(buf);
  // A 3GP with playable codecs still wants an MP4 type for Chromium.
  const plainType = /^video\/3gpp2?$/i.test(type) ? 'video/mp4' : type;
  if (!needs) return { buf, type: plainType, audio: 'ok' };
  if (buf.length > MAX_IN || !(await hasFfmpeg())) return { buf, type: plainType, audio: 'unsupported' };

  const dir = mkdtempSync(join(tmpdir(), 'sb-media-'));
  try {
    const inFile = join(dir, video ? 'in.3gp' : 'in.amr'), outFile = join(dir, video ? 'out.mp4' : 'out.m4a');
    writeFileSync(inFile, buf);
    await run(['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-f', video ? 'mov' : 'amr', '-i', inFile,
      ...(video ? ['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy'] : ['-vn']),
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-y', outFile]);
    return { buf: readFileSync(outFile), type: video ? 'video/mp4' : 'audio/mp4', audio: 'ok' };
  } catch {
    return { buf, type: plainType, audio: 'unsupported' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
