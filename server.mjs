// Local dashboard for the triage queue.
// Binds to 127.0.0.1 only — it can send SMS as you, so it must not be exposed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { tryLoadSession, clearSession, saveSession, connected, authenticate, credentials } from './lib/kazoo.mjs';
import * as secrets from './lib/secrets.mjs';
import * as profile from './lib/profile.mjs';
import { timingSafeEqual } from 'node:crypto';
import { resolve as resolvePath, sep, extname, join as joinPath } from 'node:path';
import { statSync, copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveMyBoxes } from './lib/boxes.mjs';
import { runOnce } from './lib/pipeline.mjs';
import { sendMessage } from './lib/send.mjs';
import { lines, primary, setActive, addLine, setPrimary, setLabel, removeLine } from './lib/lines.mjs';
import { load as loadContacts, save as saveContacts, ROLES } from './lib/contacts.mjs';
import { MODELS, DEFAULT_INSTRUCTIONS as TRIAGE_DEFAULT } from './lib/llm.mjs';
import * as ai from './lib/ai.mjs';
import * as review from './lib/review.mjs';
import { visionModel } from './lib/media.mjs';
import * as settings from './lib/settings.mjs';
import { invalidate, swr } from './lib/cache.mjs';
import * as store from './lib/store.mjs';
import { insights } from './lib/insights.mjs';
import { threadFor, summarizeThread } from './lib/thread.mjs';
import { listVoicemails, transcribeVoicemail, fetchVoicemailAudio } from './lib/voicemail.mjs';
import { listCalls, fetchRecordingAudio, transcribeRecording, safeId } from './lib/calls.mjs';
import { conversations, thread as convThread, fetchMedia, sendText, safeMediaId, uploadAttachment, deleteMedia,
  deleteConversation, conversationCsv } from './lib/messaging.mjs';
import { photoIndex, fileName } from './lib/photos.mjs';
import { zip } from './lib/zip.mjs';
import { playable } from './lib/transcode.mjs';
import * as fax from './lib/fax.mjs';
import { dataPath, DATA_DIR } from './lib/paths.mjs';
import * as devices from './lib/devices.mjs';

// Thumbnails need an image decoder. When hosted inside the Electron app we
// can use its nativeImage; under plain Node, thumbnails fall back to the
// full image.
let nativeImage = null;
try { const e = await import('electron'); if (e?.nativeImage?.createFromBuffer) nativeImage = e.nativeImage; } catch {}
import { directory, upsert, remove } from './lib/directory.mjs';
import { company, parked } from './lib/company.mjs';
import * as msgcache from './lib/msgcache.mjs';

const PORT = Number(process.env.UI_PORT ?? 8787);
const BACKLOG = Number((process.argv.find(a => a.startsWith('--backlog=')) ?? '--backlog=0').split('=')[1]);
// How many recent messages to pull in when a line is switched back on.
const ENABLE_BACKLOG = Number(process.env.ENABLE_BACKLOG ?? 3);
const NL = String.fromCharCode(10);

// One session object for the life of the process, mutated in place: many
// modules hold a reference. Empty until an account login succeeds.
const session = tryLoadSession() ?? {};
// Before anything reads the profile: carry an older install's servers over.
const migrated = profile.migrate(session);
// A token saved for another API server than the profile's (changed mid
// sign-in, or by hand), or with no API server at all (phone only), is not
// this account's; start signed out instead. .token.json stays for the CLI.
const baseKey = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();
if (connected(session) && (!profile.hasApi() || baseKey(session.base) !== baseKey(profile.get().apiServer)))
  for (const k of Object.keys(session)) delete session[k];
const skip = new Set();
let status = { busy: false, lastSync: null, lastError: null, processed: 0 };
const clients = new Set();

const push = (event, data) => {
  const frame = `event: ${event}${NL}data: ${JSON.stringify(data)}${NL}${NL}`;
  for (const res of clients) { try { res.write(frame); } catch {} }
};

// The data side (messages, calls, voicemail, photos, triage, insights) needs
// an API server and a signed-in session; without them the app is a phone.
const platformUp = () => profile.hasApi() && connected(session);
// The setup gate only exists where logins can be stored: in the desktop app.
const gate = () => secrets.available();
// Setup state plus which AI features are on: the sidebar, tray and Settings
// hide Triage and the morning recap while they're off.
const profileView = () => ({ ...profile.summary(session),
  triage: settings.get('triage.enabled') === true, recap: settings.get('review.enabled') === true });
const pushProfile = () => { try { push('profile', profileView()); } catch {} };
const NO_ACCOUNT = { error: 'Not signed in to an account.', code: 'no-account' };

// Morning recap: runs in the background; pages hear about it over SSE and the
// app turns 'review' into a notification.
let reviewFailedAt = 0;
function runReview(day) {
  review.run(session, day, { onDone: (r) => push('review', { day: r.day, empty: r.empty, headline: r.recap?.headline ?? '' }) })
    .catch((e) => { reviewFailedAt = Date.now(); push('review-error', { day, error: e.message }); });
}
// Checked every 5 minutes; a failed run is retried at most hourly.
setInterval(() => {
  if (platformUp() && review.due() && Date.now() - reviewFailedAt > 60 * 60e3) runReview(review.yesterday());
}, 5 * 60e3);

async function sync(reason, backlog = null) {
  if (!platformUp()) return;
  if (status.busy) return;
  // Triage off still watches for new messages: they're announced as plain
  // notifications ('inbound') instead of being triaged into the queue.
  const withAi = settings.get('triage.enabled') === true;
  status.paused = !withAi;
  // Until one pass has run for this sign-in, an unbounded pass would triage
  // the account's whole history (~15s a message), so hold it to the startup
  // backlog whoever asks first (a poll can beat startPlatform's own pass).
  const gen = generation;
  if (!primed && backlog === null) backlog = BACKLOG;
  status.busy = true; status.lastError = null;
  push('status', status);
  // A line was switched on (/api/lines): triage gets its latest few messages.
  // Done here, under the busy flag, so no other pass ever sees `skip` empty,
  // and undone if the pass fails so the next one doesn't run unbounded. Plain
  // notifications don't need it (they go by lastNewest), so it's dropped then.
  let restore = null;
  if (lineRescan && !withAi) lineRescan = false;
  if (lineRescan && primed) { restore = [...skip]; skip.clear(); backlog = ENABLE_BACKLOG; }
  try {
    const r = await runOnce(session, { backlog, skip, triage: withAi, mark: lastNewest, notified,
      onItem: (e) => push('item', e), onMessage: (m) => push('inbound', m) });
    if (gen === generation) {
      primed = true;
      lastNewest = r.newest ?? lastNewest;
      if (restore) lineRescan = false;
    }
    status.processed += r.processed.length;
    status.lastSync = new Date().toISOString();
    if (r.processed.length && withAi) push('queue', store.pending());
  } catch (e) {
    if (restore) for (const id of restore) skip.add(id);
    status.lastError = e.message;
  } finally {
    status.busy = false;
    push('status', status);
  }
}

// Small in-memory audio cache so seeking (Range requests) doesn't re-download
// the whole file from upstream on every scrub.
// In-memory media cache (audio, photos, thumbnails), bounded by total bytes so
// a scroll through the photo gallery doesn't evict everything else. Seeking
// (Range requests) and repeat views then never re-download from upstream.
const mediaCache = new Map();
const converting = new Map();     // media id -> conversion in progress (lib/transcode.mjs)
let mediaBytes = 0;
const MEDIA_BUDGET = 200 * 1024 * 1024;
async function cachedMedia(key, load) {
  if (mediaCache.has(key)) {
    const v = mediaCache.get(key); mediaCache.delete(key); mediaCache.set(key, v); return v;
  }
  const v = await load();
  mediaCache.set(key, v);
  mediaBytes += v.buf.length;
  while (mediaBytes > MEDIA_BUDGET && mediaCache.size > 1) {
    const [k, old] = mediaCache.entries().next().value;
    mediaCache.delete(k); mediaBytes -= old.buf.length;
  }
  return v;
}

// Deleted media: drop every cached form of it and the photo index.
function forgetMedia(ids = []) {
  for (const id of ids) for (const k of ['mms:', 'thumb:', 'play:']) {
    const v = mediaCache.get(k + id);
    if (v) { mediaCache.delete(k + id); mediaBytes -= v.buf.length; }
  }
  invalidate('photos:');
}

function thumbnail({ buf, type }) {
  if (!nativeImage) return { buf, type };
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return { buf, type };
  const { width } = img.getSize();
  const small = width > 360 ? img.resize({ width: 360, quality: 'good' }) : img;
  return { buf: small.toJPEG(80), type: 'image/jpeg' };
}

const attachment = (name) =>
  `attachment; filename="${String(name).replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

function sendMedia(req, res, { buf, type }, extra = {}) {
  const total = buf.length;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const head = { 'Content-Type': type || 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', ...extra };
  if (!m) { res.writeHead(200, { ...head, 'Content-Length': total }); return res.end(buf); }
  let start = m[1] ? Number(m[1]) : total - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : total - 1;
  if (!(start >= 0) || start >= total || end < start) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end();
  }
  end = Math.min(end, total - 1);
  res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
  res.end(buf.subarray(start, end + 1));
}

// Requests from the desktop app's own windows carry a per-launch key (added by
// the Electron main process). Credential endpoints require it, so neither a
// browser tab nor another local program can read or change your logins.
const APP_KEY = process.env.TRIAGE_APP_KEY || '';
let phoneStatus = null;   // last status reported by the phone window
function fromApp(req) {
  const k = String(req.headers['x-app-key'] ?? '');
  return !!APP_KEY && k.length === APP_KEY.length && timingSafeEqual(Buffer.from(k), Buffer.from(APP_KEY));
}

// ---- platform lifecycle ------------------------------------------------------
// startPlatform() brings the data side up once per sign-in; stopPlatform()
// takes it down when the account or its servers change. `generation` bumps on
// every stop, so work begun for an earlier sign-in (box lookup, a background
// sign-in, a sync in flight) can tell it is stale and drop its result.
let generation = 0;
// Bumped whenever this PC's phone login is saved, forgotten or reset, so a
// "set up my phone" request that was still waiting upstream can tell its
// answer is out of date and not save it.
let deviceEpoch = 0;
let started = false;      // startPlatform has run for this generation
let primed = false;       // a sync has completed for this sign-in (see sync())
let lastNewest = null;    // newest inbound time the last pass saw; plain notifications only announce newer
const notified = new Set();   // ids already announced as plain notifications
let lineRescan = false;   // a line was switched on; the next pass re-scans recent messages
let owned = null;         // this user's message boxes
let events = null;        // live-events socket, when an events server is set
let loginError = '';      // why the last background sign-in failed, for the Account page
let signingIn = -1;       // generation a background sign-in is running for

// No reconnect, as before: polling covers a dropped socket. A socket that
// was closed or replaced must not act on anything afterwards. Opening again
// (the events server changed) replaces the current socket.
function openEvents() {
  closeEvents();
  const url = profile.derived().eventsServer, mine = owned;
  if (!url || !mine) return;
  let ws;
  try { ws = new WebSocket(url); } catch { return; }
  events = ws;
  ws.addEventListener('open', () => {
    if (events !== ws) { try { ws.close(); } catch {} return; }
    for (const b of mine.boxes)
      ws.send(JSON.stringify({ action: 'subscribe', auth_token: session.auth_token,
                               data: { account_id: session.account_id, binding: b } }));
  });
  ws.addEventListener('message', (ev) => {
    if (events !== ws) return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.action !== 'reply') {
      // Open Messages pages fetch what's new right away (their incremental
      // fetch is cheap), rather than on their next timed check.
      push('messages', { at: Date.now() });
      sync('event');
    }
  });
  ws.addEventListener('error', () => {});
  ws.addEventListener('close', () => { if (events === ws) events = null; });
}

function closeEvents() {
  const ws = events;
  events = null;
  try { ws?.close(); } catch {}
}

async function startPlatform() {
  if (started || !platformUp()) return;
  started = true;
  const gen = generation;
  const mine = await resolveMyBoxes(session).catch(() => null);
  if (gen !== generation) return;
  owned = mine;
  console.log(`boxes      ${owned ? owned.boxes.length : '?'} (mine)`);
  // Warm the slow caches (call records ~7s upstream) in parallel with the
  // startup sync, so the first visit to Contacts or Calls doesn't wait.
  directory(platformUp() ? session : {}).catch(() => {});
  photoIndex(session).catch(() => {});
  await sync('startup', BACKLOG);
  if (gen === generation) openEvents();
}

function stopPlatform() {
  generation++;
  msgcache.clear();                     // saved texts belong to the sign-in that's ending
  started = false; primed = false;
  lastNewest = null; notified.clear(); lineRescan = false;
  closeEvents();
  owned = null;
  invalidate('');
  mediaCache.clear(); mediaBytes = 0;
}

// A sign-in replaces the session's contents, never the object. Leftovers from
// another account (send.mjs caches the sender identity on it) must not survive.
function adoptSession(fresh) {
  for (const k of Object.keys(session)) delete session[k];
  Object.assign(session, fresh);
}

// In the desktop app the login is the one saved on the Account page, so
// signing out there sticks; plain node has only .env.
const credsAvailable = () => {
  if (gate()) return secrets.status().login.set;
  const c = credentials();
  return !!(c.OOMA_USERNAME && c.OOMA_PASSWORD);
};
const signInError = (e) => ['TypeError', 'TimeoutError', 'AbortError'].includes(e?.name)
  ? 'Could not reach the API server.' : (e?.message || 'Sign-in failed.');

// With the saved login (boot, or after the servers change). A failure is kept
// for the Account page and never blocks anything else.
async function backgroundSignIn() {
  const gen = generation;
  if (signingIn === gen) return;
  signingIn = gen;
  try {
    const { session: fresh } = await authenticate(credentials(), { persist: false });
    if (gen !== generation) return;               // servers or login changed meanwhile
    if (!fresh) { loginError = 'The server did not accept the saved username and password.'; return; }
    adoptSession(fresh);
    // Only now, so a stale result never reaches disk. A failed write costs
    // only the CLI tools their token.
    try { saveSession(session); } catch {}
    loginError = '';
    startPlatform().catch(() => {});
  } catch (e) {
    if (gen === generation) loginError = signInError(e);
  } finally {
    if (signingIn === gen) signingIn = -1;
    if (gen === generation) pushProfile();
  }
}

// Pages. /account and /phone are left out on purpose: setup needs both.
const PLATFORM_PAGES = new Set(['/', '/index.html', '/messages', '/messages.html', '/calls', '/calls.html',
  '/voicemail', '/voicemail.html', '/photos', '/photos.html', '/insights', '/insights.html',
  '/parked', '/parked.html', '/fax', '/fax.html']);
const GATED_PAGES = new Set([...PLATFORM_PAGES, '/contacts', '/contacts.html', '/settings', '/settings.html']);
// Endpoints that only make sense with an account; without one they never call upstream.
const PLATFORM_API = new Set(['/api/review/run', '/api/insights', '/api/conversations', '/api/conversation',
  '/api/media', '/api/photos', '/api/photos/zip', '/api/messages/send', '/api/messages/upload', '/api/messages/delete', '/api/conversation/delete', '/api/conversation/export', '/api/account/devices', '/api/calls', '/api/recording/audio',
  '/api/recording/transcribe', '/api/voicemail/audio', '/api/voicemails', '/api/voicemail/transcribe',
  '/api/thread', '/api/sync', '/api/send', '/api/company', '/api/parked', '/api/fax', '/api/fax/pdf', '/api/fax/send']);
// Device and authorization usernames go into SIP headers as-is.
const SIP_USER = /^[^\s@:;<>"]{1,64}$/;

// Custom sounds chosen in Settings are copied here under fixed names.
const SOUNDS_DIR = dataPath('sounds');
const SOUND_FILE = /^custom-(ringtone|message|urgent)\.(mp3|wav|ogg|m4a)$/;
const SOUND_TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
const SOUND_MAX = 5 * 1024 * 1024;
// A picture-message upload: a 2 MB file as base64 plus its PNG preview, with room to spare.
const UPLOAD_MAX = 7e6;
// File name endings for saving a message attachment that isn't in the photo index.
const SAVE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/3gpp': '.3gp',
  'audio/wav': '.wav', 'audio/ogg': '.oga', 'audio/amr': '.amr', 'application/pdf': '.pdf' };

// SIP.js ships as plain ES modules; serve its lib/ directory read-only.
const SIPJS_ROOT = resolvePath(fileURLToPath(new URL('./node_modules/sip.js/lib/', import.meta.url)));

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
});
// A binary upload (a fax PDF, a picture message attachment), refused past `max` bytes.
const readRaw = (req, max, tooBig = 'That file is too large to fax.') => new Promise((resolve, reject) => {
  const parts = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error(tooBig)); req.destroy(); } else parts.push(c); });
  req.on('end', () => resolve(Buffer.concat(parts)));
  req.on('error', reject);
});
const redirect = (res, to) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    // Setup gate: until setup is finished, every page but Account leads there.
    // After it, the data pages lead to Contacts when there is no account.
    if (GATED_PAGES.has(p)) {
      if (gate() && profile.step(session) !== null) return redirect(res, '/account');
      if (PLATFORM_PAGES.has(p) && !platformUp()) return redirect(res, '/contacts');
      // The triage queue is hidden while triage is off (it needs an AI platform).
      if ((p === '/' || p === '/index.html') && settings.get('triage.enabled') !== true) return redirect(res, '/messages');
    }
    if (PLATFORM_API.has(p) && !platformUp()) return json(res, 409, NO_ACCOUNT);

    // Setup state for the pages and the app shell. Nothing secret, so no key.
    if (p === '/api/profile' && req.method === 'GET') return json(res, 200, profileView());

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./ui.html', import.meta.url)));
    }

    if (p === '/insights' || p === '/insights.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./insights.html', import.meta.url)));
    }

    // Daily recap (lib/review.mjs). Reading is open like the rest of the data;
    // starting a run is app-only, since it may spend cloud AI credit.
    if (p === '/api/review' && req.method === 'GET') {
      const day = url.searchParams.get('day');
      const days = review.list();
      const pick = review.isDay(day) ? day : days[0];
      return json(res, 200, { days, review: pick ? review.load(pick) : null, state: review.state,
                              enabled: settings.get('review.enabled'), time: settings.get('review.time') });
    }
    if (p === '/api/review/run' && req.method === 'POST') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      const { day } = await readBody(req);
      const target = review.isDay(day) ? day : review.yesterday();
      if (target >= review.dayKey()) return json(res, 400, { error: 'Only finished days can be reviewed.' });
      if (review.state.running) return json(res, 409, { error: 'A recap is already being written.' });
      runReview(target);
      return json(res, 202, { ok: true, day: target, state: review.state });
    }

    if (p === '/api/insights') {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30)));
      const out = await insights(session, { days });
      if (settings.get('triage.enabled') !== true) out.triage = null;   // triage off: no AI section
      return json(res, 200, out);
    }

    if (p === '/voicemail' || p === '/voicemail.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./voicemail.html', import.meta.url)));
    }

    if (p === '/contacts' || p === '/contacts.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./contacts.html', import.meta.url)));
    }

    if (p === '/parked' || p === '/parked.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./parked.html', import.meta.url)));
    }

    // Fax (lib/fax.mjs): only the signed-in user's own fax box, never the
    // company-wide lists the platform returns.
    if (p === '/fax' || p === '/fax.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./fax.html', import.meta.url)));
    }
    if (p === '/api/fax') {
      try { return json(res, 200, await fax.faxes(session)); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (p === '/api/fax/pdf') {
      const which = url.searchParams.get('folder'), id = url.searchParams.get('id');
      if (!['inbox', 'outbox', 'outgoing'].includes(which) || !fax.safeFaxId(id)) return json(res, 400, { error: 'bad fax id' });
      try {
        const doc = await cachedMedia(`fax:${which}:${id}`, () => fax.pdf(session, which, id));
        const extra = { 'X-Content-Type-Options': 'nosniff' };
        if (url.searchParams.get('download') === '1') {
          const day = doc.at ? new Date(doc.at).toISOString().slice(0, 10) : 'fax';
          extra['Content-Disposition'] = attachment(`fax_${day}_${String(doc.number || '').replace(/[^\d+]/g, '') || id}.pdf`);
        }
        return sendMedia(req, res, doc, extra);
      } catch (e) { return json(res, ['not one of your faxes', 'no copy of this fax'].includes(e.message) ? 404 : 502, { error: e.message }); }
    }
    // Sends a real fax: only from the app's own window, and the page asks first.
    if (p === '/api/fax/send' && req.method === 'POST') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      try {
        const file = await readRaw(req, 20 * 1024 * 1024);
        const r = await fax.send(session, { to: url.searchParams.get('to'), toName: url.searchParams.get('name') ?? '', file });
        return json(res, 200, { ok: true, ...r });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/directory') {
      const days = Math.min(3650, Math.max(1, Number(url.searchParams.get('days') ?? 365)));
      // Without the platform (phone only, or signed out) the book is just the roster.
      return json(res, 200, { contacts: await directory(platformUp() ? session : {}, { days }), roles: ROLES });
    }

    if (p === '/api/directory' && req.method === 'POST') return json(res, 405, { error: 'use /api/contacts' });

    // Everyone else on the account (Contacts > Company), plus the park codes.
    if (p === '/api/company') {
      try { return json(res, 200, await company(session)); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }

    // Calls waiting in park slots, for the phone's Parked list.
    if (p === '/api/parked') {
      try {
        const [slots, c] = await Promise.all([parked(session), company(session).catch(() => ({}))]);
        return json(res, 200, { slots, park: c.park ?? null, retrieve: c.retrieve ?? null });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }

    if (p === '/api/contacts' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        if (b.remove) { remove(b.number); return json(res, 200, { ok: true, removed: true }); }
        return json(res, 200, { ok: true, contact: upsert(b) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/settings' || p === '/settings.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./settings.html', import.meta.url)));
    }

    if (p.startsWith('/api/settings')) {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      const host = globalThis.__triageHost ?? null;

      if (p === '/api/settings' && req.method === 'GET') {
        return json(res, 200, {
          settings: settings.all(), defaults: settings.DEFAULTS,
          pages: settings.PAGES, whisperModels: settings.WHISPER_MODELS,
          triageDefault: TRIAGE_DEFAULT,   // shown as the Triage instructions placeholder
          lines: lines({ activeOnly: false }),
          host: host ? { loginItem: host.getLoginItem(), downloadsDefault: host.downloadsDefault() } : null,
          account: secrets.status(),
          profile: profileView(),
          version: JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version,
          appFolder: DATA_DIR,
        });
      }

      if (p === '/api/settings' && req.method === 'POST') {
        const patch = await readBody(req);
        try {
          const next = settings.update(patch);
          if ('general.theme' in patch) host?.setTheme(next.general.theme);
          // Once primed, an unbounded pass covers just what arrived since the last
          // one (everything older is already in `skip` or the queue).
          if ('triage.enabled' in patch && next.triage.enabled) sync('resumed');
          if ('triage.enabled' in patch || 'review.enabled' in patch) pushProfile();   // sidebar + tray follow
          push('settings', next);
          return json(res, 200, { ok: true, settings: next });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }

      // The chosen (or asked-about) AI platform's model list, for the pickers.
      // Local addresses are checked in ai.listModels. Best effort, 6s cap.
      if (p === '/api/settings/models') {
        const prov = url.searchParams.get('provider') || ai.provider();
        if (!ai.PROVIDERS.includes(prov)) return json(res, 400, { error: 'unknown platform' });
        try {
          const models = await ai.listModels(prov, { url: url.searchParams.get('url') || undefined });
          return json(res, 200, { ok: true, provider: prov, models });
        } catch (e) { return json(res, 200, { ok: false, provider: prov, error: e.message, models: [] }); }
      }

      if (p === '/api/settings/action' && req.method === 'POST') {
        const { action, value } = await readBody(req);
        try {
          if (action === 'loginItem') { if (!host) throw new Error('only in the desktop app'); host.setLoginItem(!!value); return json(res, 200, { ok: true, loginItem: host.getLoginItem() }); }
          if (action === 'pickFolder') { if (!host) throw new Error('only in the desktop app');
            const folder = await host.pickFolder(settings.get('downloads.folder') || host.downloadsDefault());
            if (folder) settings.update({ 'downloads.folder': folder });
            return json(res, 200, { ok: true, folder: settings.get('downloads.folder') }); }
          if (action === 'openFolder') { if (!host) throw new Error('only in the desktop app');
            host.openFolder(settings.get('downloads.folder') || host.downloadsDefault()); return json(res, 200, { ok: true }); }
          if (action === 'pickSound') {
            if (!host) throw new Error('only in the desktop app');
            const slot = String(value ?? '');
            if (!['ringtone', 'message', 'urgent'].includes(slot)) throw new Error('unknown sound');
            const src = await host.pickFile({ title: 'Choose a sound',
              filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }] });
            if (!src) return json(res, 200, { ok: true, cancelled: true });
            const ext = extname(src).toLowerCase();
            if (!SOUND_TYPES[ext]) throw new Error('Use an mp3, wav, ogg or m4a file.');
            if (statSync(src).size > SOUND_MAX) throw new Error('That file is over 5 MB.');
            mkdirSync(SOUNDS_DIR, { recursive: true });
            for (const f of readdirSync(SOUNDS_DIR)) if (f.startsWith(`custom-${slot}.`)) rmSync(joinPath(SOUNDS_DIR, f), { force: true });
            const name = `custom-${slot}${ext}`;
            copyFileSync(src, joinPath(SOUNDS_DIR, name));
            const next = settings.update({ [`sounds.${slot}`]: 'custom', [`sounds.${slot}File`]: name });
            push('settings', next);
            return json(res, 200, { ok: true, settings: next });
          }
          if (action === 'createShortcut') {
            if (!host) throw new Error('only in the desktop app');
            const r = host.createShortcut();
            if (!r.ok) throw new Error('Windows would not create the shortcut.');
            return json(res, 200, { ok: true, path: r.path });
          }
          if (action === 'testNotify') {
            if (!host) throw new Error('only in the desktop app');
            host.testNotify(value === 'urgent' ? 'urgent' : 'normal');
            return json(res, 200, { ok: true });
          }
          // Cloud AI key: checked with the platform before it is stored; an
          // empty value removes it. The key itself never comes back out.
          if (action === 'aiKey') {
            if (!secrets.available()) throw new Error('API keys can only be saved in the desktop app.');
            const prov = String(value?.provider ?? '');
            if (!ai.isCloud(prov)) throw new Error('unknown platform');
            const r = await ai.setKey(prov, value?.key);
            return json(res, 200, { ...r, account: secrets.status() });
          }
          // One tiny structured request to the current platform's text model:
          // proves key, model access and JSON output all work end to end.
          if (action === 'aiTest') {
            const t0 = Date.now();
            const out = await ai.json({
              name: 'ping', system: 'Connection test. Answer with ok set to true.', user: 'ping',
              schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
            });
            if (out?.ok !== true) throw new Error('The model answered, but not as expected.');
            return json(res, 200, { ok: true, model: ai.textModel(), ms: Date.now() - t0 });
          }
          if (action === 'clearCache') {
            invalidate(''); mediaCache.clear(); mediaBytes = 0;
            directory(platformUp() ? session : {}).catch(() => {});
            if (platformUp()) photoIndex(session).catch(() => {});
            return json(res, 200, { ok: true });
          }
          if (action === 'reset') { const next = settings.reset(); host?.setTheme(next.general.theme); push('settings', next); pushProfile(); return json(res, 200, { ok: true, settings: next }); }
          return json(res, 400, { error: 'unknown action' });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 404, { error: 'not found' });
    }

    if (p === '/account' || p === '/phone') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('.' + p + '.html', import.meta.url)));
    }

    if (p.startsWith('/vendor/sipjs/')) {
      const target = resolvePath(SIPJS_ROOT, decodeURIComponent(p.slice('/vendor/sipjs/'.length)));
      if (!target.startsWith(SIPJS_ROOT + sep) || !target.endsWith('.js')) return json(res, 404, { error: 'not found' });
      try {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
        return res.end(await readFile(target));
      } catch { return json(res, 404, { error: 'not found' }); }
    }

    // Setup's "use one of my phones": GET lists the signed-in user's own phone
    // devices; POST {action:'use', id} saves that device's SIP login here
    // (encrypted), like typing it into the form would. Nothing on the account
    // is created or changed.
    if (p === '/api/account/devices') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      if (!secrets.available()) return json(res, 400, { error: 'Secure storage isn’t available on this PC, so a phone login can’t be saved.' });
      try {
        if (req.method === 'GET') return json(res, 200, await devices.listMine(session));
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        const b = await readBody(req);
        const gen = generation, epoch = deviceEpoch, who = session.account_id + ':' + session.owner_id;
        if (b.action !== 'use') return json(res, 400, { error: 'nothing to do' });
        const got = await devices.useMine(session, b.id);
        // Signed out, reset, or the phone login changed while this waited upstream.
        if (gen !== generation || epoch !== deviceEpoch || who !== session.account_id + ':' + session.owner_id)
          return json(res, 409, { error: 'Your sign-in or phone settings changed while this was running. Try again.' });
        if (!SIP_USER.test(got.username)) return json(res, 400, { error: 'That phone device’s SIP username can’t be used here.' });
        secrets.set({ 'sip.username': got.username, 'sip.password': got.password, 'sip.authUsername': '' });
        deviceEpoch++;
        pushProfile();
        return json(res, 200, { ok: true, account: profile.status(session, { loginError }), device: { name: got.name, webrtc: got.webrtc } });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/account' || p === '/api/sip/config') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });

      if (p === '/api/sip/config') return json(res, 200, profile.sipConfig());

      const account = () => profile.status(session, { loginError });
      if (req.method === 'GET') return json(res, 200, account());

      const b = await readBody(req);
      const saved = () => { pushProfile(); return json(res, 200, { ok: true, account: account() }); };
      const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
      try {
        // Start over: servers, login and device go; AI keys and settings stay.
        if (b.reset === true) {
          deviceEpoch++;
          stopPlatform(); clearSession(session); loginError = '';
          if (secrets.available()) {
            secrets.forget('login.');
            secrets.set({ 'sip.username': null, 'sip.password': null, 'sip.authUsername': null });
          }
          profile.clear();
          return saved();
        }

        if (b.forget === 'login') {
          secrets.forget('login.');
          stopPlatform(); clearSession(session); loginError = '';
          return saved();
        }

        if (b.forget === 'device') {
          deviceEpoch++;
          secrets.set({ 'sip.username': null, 'sip.password': null, 'sip.authUsername': null });
          return saved();
        }

        // Only the fields sent change; realm and WebSocket server must end up set.
        if (obj(b.server)) {
          const patch = {};
          for (const f of profile.FIELDS)
            if (Object.hasOwn(b.server, f)) patch[f] = b.server[f] == null ? '' : String(b.server[f]).trim();
          const before = profile.get();
          // Another API server origin is another provider: the old advanced
          // servers would be sent this account's token, so they go unless
          // edited in this same save.
          const origin = (u) => { try { return new URL(u).origin.toLowerCase(); } catch { return ''; } };
          const sameUrl = (a, b) => String(a ?? '').trim().replace(/\/+$/, '') === String(b ?? '').trim().replace(/\/+$/, '');
          const apiNext = Object.hasOwn(patch, 'apiServer') ? patch.apiServer : before.apiServer;
          if (origin(apiNext) !== origin(before.apiServer))
            for (const f of ['eventsServer', 'messagingServer', 'mediaServer'])
              if (!Object.hasOwn(patch, f) || sameUrl(patch[f], before[f])) patch[f] = '';
          const want = { ...before, ...patch };
          if (!want.realm) return json(res, 400, { error: 'Enter the SIP realm (domain).' });
          if (!want.wsServer) return json(res, 400, { error: 'Enter the WebSocket server.' });
          const errors = profile.validate(patch);
          if (errors.length) return json(res, 400, { error: errors.join(' ') });
          const eventsBefore = profile.derived(before).eventsServer;
          const after = profile.update(patch);

          // A different API server or realm is a different account: sign out of
          // the old one, then back in with the saved login if there is one.
          if (after.apiServer !== before.apiServer || after.realm !== before.realm) {
            stopPlatform(); clearSession(session); loginError = '';
            if (!after.apiServer) { if (secrets.available()) secrets.forget('login.'); }
            else if (credsAvailable()) backgroundSignIn().catch(() => {});
          } else if (started && profile.derived(after).eventsServer !== eventsBefore) {
            openEvents();
          }
          return saved();
        }

        // Checked with the server before anything is stored.
        if (obj(b.login)) {
          if (!profile.hasApi()) return json(res, 400, { error: 'Set an API server first.' });
          const username = String(b.login.username ?? '').trim();
          let password = String(b.login.password ?? '');
          // Blank password for the saved username = retry with the saved one
          // (e.g. after a background sign-in failed while offline).
          if (!password && username && username === secrets.get('login.username')) password = secrets.get('login.password') || '';
          if (!username || !password) return json(res, 400, { error: 'Enter both username and password.' });
          // Servers, sign-out or another sign-in may change while this one waits.
          const gen = generation, { apiServer, realm } = profile.get();
          let fresh;
          try { ({ session: fresh } = await authenticate({ ...credentials(), OOMA_USERNAME: username, OOMA_PASSWORD: password },
                                                         { persist: false })); }
          catch (e) { return json(res, 502, { error: signInError(e) }); }
          const now = profile.get();
          if (gen !== generation || now.apiServer !== apiServer || now.realm !== realm)
            return json(res, 409, { error: 'The servers or sign-in changed while signing in. Try again.' });
          if (!fresh) return json(res, 401, { error: 'The server did not accept that username and password.' });
          secrets.set({ 'login.username': username, 'login.password': password });
          // Whatever was running belonged to the previous sign-in (maybe another account).
          stopPlatform();
          adoptSession(fresh);
          try { saveSession(session); } catch {}     // a failed write costs only the CLI tools their token
          loginError = '';
          startPlatform().catch(() => {});
          return saved();
        }

        if (obj(b.device)) {
          const username = String(b.device.username ?? '').trim(), password = String(b.device.password ?? '');
          const authUsername = String(b.device.authUsername ?? '').trim();
          if (!username) return json(res, 400, { error: 'Enter the device SIP username.' });
          if (!SIP_USER.test(username)) return json(res, 400, { error: 'The SIP username can\'t contain spaces or any of @ : ; < > ".' });
          if (authUsername && !SIP_USER.test(authUsername))
            return json(res, 400, { error: 'The authorization username can\'t contain spaces or any of @ : ; < > ".' });
          if (!password && !secrets.get('sip.password')) return json(res, 400, { error: 'Enter the device SIP password.' });
          // Blank password keeps the saved one; blank authorization username removes it.
          const patch = { 'sip.username': username, 'sip.authUsername': authUsername };
          if (password) patch['sip.password'] = password;
          deviceEpoch++;
          secrets.set(patch);
          return saved();
        }
        return json(res, 400, { error: 'nothing to do' });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (p === '/messages' || p === '/messages.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./messages.html', import.meta.url)));
    }

    if (p === '/dialpad.js' || p === '/nav.js' || p === '/sounds.js' || p === '/bg.js' || p === '/emoji.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(await readFile(new URL('.' + p, import.meta.url)));
    }

    if (p === '/glass.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      return res.end(await readFile(new URL('./glass.css', import.meta.url)));
    }

    if (p === '/assets/bg-dark.webp' || p === '/assets/bg-light.webp') {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=86400' });
      return res.end(await readFile(new URL('.' + p, import.meta.url)));
    }

    if (p.startsWith('/sounds/')) {
      const name = p.slice('/sounds/'.length);
      if (!SOUND_FILE.test(name)) return json(res, 404, { error: 'not found' });
      try {
        const buf = await readFile(joinPath(SOUNDS_DIR, name));
        return sendMedia(req, res, { buf, type: SOUND_TYPES[extname(name)] ?? 'application/octet-stream' });
      } catch { return json(res, 404, { error: 'not found' }); }
    }

    // Phone window status (state + error text only), for diagnostics.
    if (p === '/api/phone/status') {
      if (req.method === 'POST') {
        if (!fromApp(req)) return json(res, 403, { error: 'forbidden' });
        const b = await readBody(req);
        phoneStatus = { state: String(b.state ?? ''), detail: String(b.detail ?? '').slice(0, 300),
                        inCall: !!b.inCall, at: new Date().toISOString() };
        return json(res, 200, { ok: true });
      }
      return json(res, 200, phoneStatus ?? { state: 'unknown', detail: 'phone window has not reported yet' });
    }

    // Sidebar counts. Cached briefly: every open page asks every 30s.
    if (p === '/api/badges') {
      if (!platformUp()) return json(res, 200, { unread: 0, voicemail: 0, parked: 0, pending: store.pending().length });
      const b = await swr('badges:' + session.owner_id, 20e3, async () => {
        const [convs, vms, lot] = await Promise.all([
          conversations(session).catch(() => []),
          listVoicemails(session).catch(() => []),
          parked(session).catch(() => []),          // uncached and throws on a bad upstream reply
        ]);
        return {
          unread: convs.filter(c => c.unread > 0).length,
          voicemail: vms.filter(v => v.folder === 'new').length,
          parked: lot.length,
        };
      }).catch(() => ({ unread: 0, voicemail: 0, parked: 0 }));
      return json(res, 200, { ...b, pending: store.pending().length });
    }

    if (p === '/api/conversations') {
      // cached=1: the saved copy only (null if none yet), for an instant first paint.
      try { return json(res, 200, { conversations: await conversations(session, { line: url.searchParams.get('line') || null,
                                                                                   cached: url.searchParams.get('cached') === '1' }) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/conversation') {
      try {
        return json(res, 200, { messages: await convThread(session, {
          line: url.searchParams.get('line'), remote: url.searchParams.get('remote'),
          cached: url.searchParams.get('cached') === '1' }) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/media') {
      const id = url.searchParams.get('id'), line = url.searchParams.get('line');
      if (!safeMediaId(id)) return json(res, 400, { error: 'bad id' });
      try {
        const full = () => cachedMedia('mms:' + id, () => fetchMedia(session, id, line));
        if (url.searchParams.get('thumb') === '1')
          return sendMedia(req, res, await cachedMedia('thumb:' + id, async () => thumbnail(await full())));
        // Video / voice memo pressed play: phone audio (AMR) converted so it has
        // sound. The player asks in several Range requests, so one conversion
        // is shared between them.
        if (url.searchParams.get('play') === '1') {
          const key = 'play:' + id;
          if (!converting.has(key)) converting.set(key, cachedMedia(key, async () => playable(await full()))
            .finally(() => converting.delete(key)));
          const v = await converting.get(key);
          return sendMedia(req, res, v, { 'X-Audio': v.audio || 'ok' });
        }
        const extra = {};
        const v = await full();
        if (url.searchParams.get('download') === '1') {
          const meta = (await photoIndex(session).catch(() => [])).find(x => x.id === id);
          const type = String(v.type).split(';')[0].trim().toLowerCase();
          extra['Content-Disposition'] = attachment(meta ? fileName(meta)
            : (type.startsWith('image/') ? 'photo_' : 'attachment_') + id + (SAVE_EXT[type] ?? (type.startsWith('image/') ? '.jpg' : '')));
        }
        return sendMedia(req, res, v, extra);
      } catch (e) { return json(res, 502, { error: e.message }); }
    }

    if (p === '/photos' || p === '/photos.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./photos.html', import.meta.url)));
    }

    if (p === '/api/photos') {
      try {
        let list = await photoIndex(session);
        const line = url.searchParams.get('line'), remote = url.searchParams.get('remote');
        if (line) list = list.filter(x => x.line === line);
        if (remote) { const d = String(remote).replace(/\D/g, '').slice(-10); list = list.filter(x => x.remote.endsWith(d)); }
        return json(res, 200, { photos: list });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }

    // Zip of photos: GET ?line=&remote= for one conversation, or POST ids=a,b,c
    // (a form post, so the browser treats the reply as a download).
    if (p === '/api/photos/zip') {
      try {
        const idx = await photoIndex(session);
        let pick = [], label = 'photos';
        if (req.method === 'POST') {
          let raw = '';
          for await (const chunk of req) { raw += chunk; if (raw.length > 2e5) break; }
          const ids = new Set((new URLSearchParams(raw).get('ids') || '').split(',').filter(safeMediaId));
          pick = idx.filter(x => ids.has(x.id));
          label = `photos_${pick.length}`;
        } else {
          const line = url.searchParams.get('line');
          const d = String(url.searchParams.get('remote') ?? '').replace(/\D/g, '').slice(-10);
          pick = idx.filter(x => (!line || x.line === line) && d && x.remote.endsWith(d));
          const who = pick[0] ? String(pick[0].name || pick[0].remote).replace(/[^A-Za-z0-9+]+/g, '_') : 'chat';
          label = `photos_${who}`;
        }
        if (!pick.length) return json(res, 404, { error: 'no photos' });
        if (pick.length > 300) return json(res, 413, { error: 'too many photos for one zip (max 300)' });

        pick = [...pick].sort((a, b) => a.at - b.at);
        const files = new Array(pick.length);
        let next = 0, failed = 0;
        await Promise.all(Array.from({ length: Math.min(4, pick.length) }, async () => {
          while (next < pick.length) {
            const i = next++, ph = pick[i];
            try {
              const m = await cachedMedia('mms:' + ph.id, () => fetchMedia(session, ph.id, ph.line));
              files[i] = { name: fileName(ph, i + 1), data: m.buf, date: new Date(ph.at) };
            } catch { failed++; }
          }
        }));
        const buf = zip(files.filter(Boolean));
        const today = new Date().toISOString().slice(0, 10);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': buf.length,
          'Content-Disposition': attachment(`${label}_${today}.zip`), 'X-Photos-Failed': String(failed) });
        return res.end(buf);
      } catch (e) { return json(res, 502, { error: e.message }); }
    }

    // Sends as the user, so only the app's own windows may (as with faxes).
    if (p === '/api/messages/send' && req.method === 'POST') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      const { line, to, text, media = [], clientMsgId = null } = await readBody(req);
      try {
        const r = await sendText(session, { line, to, text, media, clientMsgId });
        if (media.length) invalidate('photos:');
        return json(res, 200, r);
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // Deletes a message, or one photo/attachment of it: JSON
    // {line, remote, messageId, mediaId?}. Only the app's own windows may.
    if (p === '/api/messages/delete' && req.method === 'POST') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      const { line, remote, messageId, mediaId = null } = await readBody(req);
      try {
        const r = await deleteMedia(session, { line, remote, messageId, mediaId });
        forgetMedia(r.media);
        return json(res, 200, r);
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // Deletes a whole conversation: JSON {line, remote}.
    if (p === '/api/conversation/delete' && req.method === 'POST') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      const { line, remote } = await readBody(req);
      try {
        const r = await deleteConversation(session, { line, remote });
        forgetMedia(r.media);
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // A conversation's history as a CSV download (the app's own windows only).
    if (p === '/api/conversation/export' && req.method === 'GET') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      try {
        const { csv, name } = await conversationCsv(session, { line: url.searchParams.get('line'), remote: url.searchParams.get('remote') });
        const who = String(name).replace(/[^A-Za-z0-9+]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'conversation';
        const buf = Buffer.from(csv, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': buf.length,
          'Content-Disposition': attachment(`Messages_${who}_${new Date().toISOString().slice(0, 10)}.csv`) });
        return res.end(buf);
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // One picture-message attachment, uploaded before the message that carries
    // it: JSON {line, name, type, data: base64, thumb: PNG data URL | null}.
    // Answers {id} for /api/messages/send's media list.
    if (p === '/api/messages/upload' && req.method === 'POST') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      const tooBig = 'That file is too large to send (2 MB at most).';
      if (Number(req.headers['content-length'] ?? 0) > UPLOAD_MAX) return json(res, 413, { error: tooBig });
      try {
        let b;
        try { b = JSON.parse((await readRaw(req, UPLOAD_MAX, tooBig)).toString('utf8')); }
        catch (e) { throw e.message === tooBig ? e : new Error('bad upload'); }
        const data = Buffer.from(String(b?.data ?? ''), 'base64');
        const type = String(b?.type ?? '').toLowerCase();
        const { id } = await uploadAttachment(session, { line: b?.line, name: b?.name, type, data, thumb: b?.thumb ?? null });
        // The thread shows it straight away, without downloading it back.
        cachedMedia('mms:' + id, async () => ({ buf: data, type })).catch(() => {});
        return json(res, 200, { ok: true, id });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/calls' || p === '/calls.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./calls.html', import.meta.url)));
    }

    if (p === '/api/calls') {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30)));
      return json(res, 200, { calls: await listCalls(session, { days }) });
    }

    if (p === '/api/recording/audio') {
      const id = url.searchParams.get('id');
      if (!safeId(id)) return json(res, 400, { error: 'bad id' });
      try { return sendMedia(req, res, await cachedMedia('rec:' + id, () => fetchRecordingAudio(session, id))); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }

    if (p === '/api/recording/transcribe' && req.method === 'POST') {
      const { id, force } = await readBody(req);
      if (!safeId(id)) return json(res, 400, { error: 'bad id' });
      try { return json(res, 200, await transcribeRecording(session, id, { force: !!force })); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (p === '/api/voicemail/audio') {
      const box = url.searchParams.get('box_id'), media = url.searchParams.get('media_id');
      if (!safeId(box) || !safeId(media)) return json(res, 400, { error: 'bad id' });
      try { return sendMedia(req, res, await cachedMedia('vm:' + media, () => fetchVoicemailAudio(session, box, media))); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }

    if (p === '/api/voicemails') {
      return json(res, 200, { voicemails: await listVoicemails(session) });
    }

    if (p === '/api/voicemail/transcribe' && req.method === 'POST') {
      const { box_id, media_id, force } = await readBody(req);
      if (!box_id || !media_id) return json(res, 400, { error: 'box_id and media_id required' });
      try { return json(res, 200, await transcribeVoicemail(session, box_id, media_id, { force: !!force })); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (p === '/api/thread') {
      const remote = url.searchParams.get('remote');
      if (!remote) return json(res, 400, { error: 'remote required' });
      const msgs = await threadFor(session, remote);
      const flat = msgs.map(m => ({ at: m.at, inbound: m.inbound, text: m.forModel(), state: m.state }));
      if (url.searchParams.get('summary') !== '1') return json(res, 200, { messages: flat });
      try { return json(res, 200, { messages: flat, summary: await summarizeThread(msgs) }); }
      catch (e) { return json(res, 200, { messages: flat, error: e.message }); }
    }

    if (p === '/api/state') {
      return json(res, 200, {
        pending: store.pending(),
        resolved: store.all().filter(e => e.resolution).length,
        lines: lines({ activeOnly: false }),
        contacts: loadContacts(),
        roles: ROLES,
        models: { triage: MODELS.triage, vision: visionModel() },
        status,
      });
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: status${NL}data: ${JSON.stringify(status)}${NL}${NL}`);
      res.write(`event: profile${NL}data: ${JSON.stringify(profileView())}${NL}${NL}`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/sync' && req.method === 'POST') {
      const b = await readBody(req);
      sync('manual', b.backlog ?? null);
      return json(res, 202, { started: true });
    }

    if (p === '/api/lines' && req.method === 'POST') {
      if (APP_KEY && !fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      const b = await readBody(req);
      try {
        let all;
        if (b.add) all = addLine(b.number, b.label ?? '', b.active !== false);
        else if (b.remove) all = removeLine(b.number);
        else if (b.primary) all = setPrimary(b.number);
        else if (typeof b.label === 'string') all = setLabel(b.number, b.label);
        else if (typeof b.active === 'boolean') all = setActive(b.number, b.active);
        else return json(res, 400, { error: 'nothing to do' });
        // A line coming back online picks up only its most recent messages.
        // Syncing unbounded here would triage that line's whole history —
        // ~15s per message, which pins the machine for minutes.
        if (b.active === true || b.add) { lineRescan = true; sync('line-enabled'); }
        invalidate('photos:'); invalidate('dir:');
        push('lines', all);
        return json(res, 200, { ok: true, lines: all });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/reject' && req.method === 'POST') {
      const { id } = await readBody(req);
      store.resolve(id, 'rejected');
      push('queue', store.pending());
      return json(res, 200, { ok: true });
    }

    if (p === '/api/contact' && req.method === 'POST') {
      const { number, role, name } = await readBody(req);
      const roster = loadContacts();
      const k = String(number).replace(/[^\d+]/g, '');
      roster[k] = { ...(roster[k] ?? {}), role: role ?? 'unknown', name: name ?? roster[k]?.name ?? '' };
      saveContacts(roster);
      return json(res, 200, { ok: true, contacts: roster });
    }

    if (p === '/api/send' && req.method === 'POST') {
      const { id, text, dryRun = true } = await readBody(req);
      if (!dryRun && !fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      const item = store.pending().find(e => e.id === id);
      if (!item) return json(res, 404, { error: 'not in queue' });
      if (!text?.trim()) return json(res, 400, { error: 'empty message' });

      const r = await sendMessage(session, {
        to: item.remote, text, localNumber: item.local ?? primary(), dryRun,
      });
      if (!dryRun && r.ok) {
        store.resolve(id, 'sent', { sent_text: text });
        push('queue', store.pending());
      }
      return json(res, r.dryRun || r.ok ? 200 : 502, r);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dashboard  http://127.0.0.1:${PORT}`);
  console.log(`lines      ${lines().map(l => l.number).join(', ')}`);
  console.log(`models     ${MODELS.triage} / ${visionModel()}`);
  if (migrated.profile) console.log('profile    servers carried over from the previous version');
  if (platformUp()) startPlatform().catch(() => {});
  else if (profile.hasApi() && credsAvailable()) { console.log('account    signing in'); backgroundSignIn().catch(() => {}); }
  else console.log(`account    ${profile.hasApi() ? 'not signed in' : 'none (phone only)'}`);

  // Always running; sync() does nothing until there is an account. The
  // interval comes from settings each round, so a change applies on the next
  // tick without restarting.
  const poll = () => setTimeout(async () => { await sync('poll'); poll(); },
    settings.get('triage.pollSeconds') * 1000);
  poll();
});
