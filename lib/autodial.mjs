// Auto-dial results store.
//
// The dialing and the audio classification all happen in the browser (autodial.html):
// it owns the SIP connection and the WebRTC audio, which is where Web Audio can
// see it. This module only keeps what that page produces — one run's list of
// results, plus a short recording per answered call — on disk under the data
// folder, so the page survives a reload and the run can be exported.
//
// A "run" is one pass over a list of numbers. Starting a new run clears the last.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from './paths.mjs';

const DIR = dataPath('autodial');
const REC_DIR = join(DIR, 'recordings');
const FILE = join(DIR, 'run.json');

const REC_EXT = { 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a' };
// A recording is a few seconds of 8 kHz phone audio; this is a generous ceiling.
export const RECORDING_MAX = 2 * 1024 * 1024;
// A number is an id-safe token: digits, +, *, #, and the row index we append.
const ID = /^[0-9+*#_-]{1,40}$/;

function ensure() { mkdirSync(REC_DIR, { recursive: true }); }

// A run is driven by a hidden background window (autodial-runner.html) so it
// keeps going when you navigate away from the Auto-dial page. The server holds
// the whole job — the plan (numbers, options, line) and a `running` flag the
// runner watches — plus the results it appends. `token` identifies one run so
// the runner can tell a fresh Start from the one it's already on.
const empty = () => ({ startedAt: 0, finishedAt: 0, total: 0, options: {}, numbers: [], lineId: '', running: false, token: 0, results: [] });

export function state() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return empty(); }
}

function write(run) {
  ensure();
  writeFileSync(FILE, JSON.stringify(run));
  return run;
}

// Begin a fresh run: wipe the previous results and recordings, record the plan
// and flip `running` on. The background runner picks it up on its next poll.
export function start({ numbers = [], options = {}, lineId = '' } = {}) {
  ensure();
  try { for (const f of readdirSync(REC_DIR)) rmSync(join(REC_DIR, f), { force: true }); } catch {}
  const list = (Array.isArray(numbers) ? numbers : []).map((n) => String(n)).filter(Boolean).slice(0, 10000);
  return write({ startedAt: Date.now(), finishedAt: 0, total: list.length, options, numbers: list,
    lineId: String(lineId || ''), running: true, token: Date.now(), results: [] });
}

// Stop the current run (the runner sees running:false and halts after/aborting
// the call in progress). Results stay.
export function stop() {
  const run = state();
  run.running = false;
  run.finishedAt = run.finishedAt || Date.now();
  return write(run);
}

// Append one finished call. The page sends the fields it worked out; we keep a
// fixed shape so the CSV is stable.
export function append(r = {}) {
  const run = state();
  run.results.push({
    number: String(r.number || ''),
    status: String(r.status || ''),            // answered | no-answer | busy | failed | rejected | stopped
    classification: String(r.classification || ''),  // voice | fax | modem | sit | silence | unknown | ''
    subtype: String(r.subtype || ''),
    ringMs: Number(r.ringMs) || 0,
    ringCount: Number(r.ringCount) || 0,
    durationMs: Number(r.durationMs) || 0,
    sipCode: Number(r.sipCode) || 0,
    note: String(r.note || '').slice(0, 200),
    recording: r.recording && ID.test(String(r.recording).replace(/\.[a-z0-9]+$/i, '')) ? String(r.recording) : '',
    at: Date.now(),
  });
  return write(run);
}

export function finish() {
  const run = state();
  run.finishedAt = Date.now();
  run.running = false;
  return write(run);
}

export function clear() {
  ensure();
  try { rmSync(FILE, { force: true }); } catch {}
  try { for (const f of readdirSync(REC_DIR)) rmSync(join(REC_DIR, f), { force: true }); } catch {}
  return empty();
}

// Store one call's recording. `id` is the row token the page assigns (e.g. the
// number plus its index); the saved name is id + extension.
export function saveRecording(id, buffer, contentType) {
  ensure();
  const base = String(id || '').replace(/[^0-9+*#_-]/g, '');
  if (!base || !ID.test(base)) throw new Error('bad recording id');
  const ext = REC_EXT[contentType] || '.webm';
  const name = base + ext;
  writeFileSync(join(REC_DIR, name), buffer);
  return name;
}

export function recordingPath(name) {
  const base = String(name || '');
  if (!/^[0-9+*#_-]{1,40}\.[a-z0-9]{2,4}$/i.test(base)) return null;
  const p = join(REC_DIR, base);
  return existsSync(p) ? p : null;
}

const RECORDING_TYPE = { '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };
export const recordingType = (name) => RECORDING_TYPE[String(name).toLowerCase().replace(/^.*(\.[a-z0-9]+)$/i, '$1')] || 'application/octet-stream';

// One run as CSV. Header line then a row per result.
export function csv() {
  const run = state();
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['number', 'status', 'classification', 'subtype', 'ring_seconds', 'ring_count', 'duration_seconds', 'sip_code', 'note', 'recording', 'time'];
  const rows = run.results.map((r) => [
    r.number, r.status, r.classification, r.subtype,
    (r.ringMs / 1000).toFixed(1), r.ringCount || '', (r.durationMs / 1000).toFixed(1),
    r.sipCode || '', r.note, r.recording, new Date(r.at).toISOString(),
  ].map(esc).join(','));
  return head.join(',') + '\n' + rows.join('\n') + (rows.length ? '\n' : '');
}
