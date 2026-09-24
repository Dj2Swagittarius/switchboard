// Plain messaging: conversation list, full threads, MMS images, send.
// Independent of triage — nothing here touches the queue.
//
// Endpoints mirror what the official client uses (seen in the CDP capture):
//   list:   GET /v2/messaging?localNumber=&threadsOnly=true&filterBy=non_empty_threads
//   thread: GET /v2/messaging?localNumber=&remoteNumber=&page_size=
import { api } from './kazoo.mjs';
import { lines } from './lines.mjs';
import { load as loadContacts } from './contacts.mjs';
import { sendMessage, uploadMedia, deleteAttachment, deleteMessages, deleteThread, MMS_TYPES, MMS_MAX_BYTES, MMS_MAX_FILES } from './send.mjs';
import { derived } from './profile.mjs';
import * as cache from './msgcache.mjs';

// MMS attachments live under the profile's media server (ends in '/'); sending
// goes through lib/send.mjs, which uses its messaging server.
const MAX_TEXT = 2048;   // matches the official client's counter

const digits = (n) => String(n ?? '').replace(/\D/g, '');
export const e164 = (n) => {
  const d = digits(n);
  return d.length === 10 ? '+1' + d : d.length >= 11 && d.length <= 15 ? '+' + d : null;
};
const first = (n) => (Array.isArray(n) ? n[0] : n);
export const safeMediaId = (id) => /^[A-Za-z0-9_-]{8,80}$/.test(String(id ?? ''));

function myLine(line) {
  const k = e164(line);
  const ok = lines().some(l => e164(l.number) === k);
  if (!ok) throw new Error('not one of your enabled lines');
  return k;
}

// Page through a messaging query until the API stops handing back start_key.
async function pages(session, params, { maxPages = 20 } = {}) {
  const out = [];
  let start = null;
  for (let p = 0; p < maxPages; p++) {
    const q = new URLSearchParams(params);
    if (start) q.set('start_key', start);
    const r = await api(session, `/messaging?${q}`);
    out.push(...(r.body?.data ?? []));
    start = r.body?.next_start_key ?? null;
    if (!start) break;
  }
  return out;
}

// cached: answer from msg-cache.json only (null if nothing is saved yet), so
// the page can draw at once and then ask again for the live list.
export async function conversations(session, { line = null, cached = false } = {}) {
  // Only enabled lines. A line switched off in lines.json is off everywhere:
  // not watched, not listed, and not usable for sending.
  const which = line ? [myLine(line)] : lines().map(l => e164(l.number));
  const lineKey = line ? which[0] : '';
  // (Filtered again: a line switched off since the copy was saved stays hidden.)
  if (cached) return cache.getList(session, lineKey)?.conversations?.filter(c => which.includes(c.line)) ?? null;
  const roster = loadContacts();

  let failed = false;
  const perLine = await Promise.all(which.map(async (L) => {
    const threads = await pages(session, {
      localNumber: L, filterBy: 'non_empty_threads', page_size: '100', threadsOnly: 'true',
    }).catch(() => { failed = true; return []; });
    return threads.map(t => ({ L, t }));
  }));

  const list = perLine.flat().map(({ L, t }) => {
    const remote = e164(first(t.remoteNumber)) ?? String(first(t.remoteNumber) ?? '');
    const lm = t.lastMessage ?? {};
    const c = roster[remote];
    return {
      line: L,
      remote,
      name: c?.name ?? '',
      role: c?.role ?? '',
      unread: Number(t.unread ?? 0),
      count: Number(t.count ?? 0),
      lastAt: Number(t.lastMsgTs ?? lm.createdTs ?? 0),
      last: {
        text: typeof lm.text === 'string' ? lm.text : '',
        inbound: lm.direction === 'IN',
        media: (lm.media ?? []).length,
        mime: lm.media?.[0]?.media?.mime_type ?? '',
      },
    };
  }).sort((a, b) => b.lastAt - a.lastAt);
  // A line that failed to load would drop its threads from the saved copy.
  if (!failed) cache.putList(session, lineKey, list);
  return list;
}

const norm = (m) => ({
  id: m.id,
  at: Number(m.createdTs ?? m.sentTs ?? 0),
  inbound: m.direction === 'IN',
  text: typeof m.text === 'string' ? m.text : '',
  state: m.state ?? '',
  failed: m.direction === 'OUT' && Number(m.reasonId ?? 0) !== 0,
  reason: m.reasonText ?? '',
  media: (m.media ?? [])
    .filter(x => safeMediaId(x.media_id))
    .map(x => ({ id: x.media_id, mime: x.media?.mime_type ?? '' })),
});
const byTime = (a, b) => a.at - b.at;

// One page of a thread, newest first. Unlike pages(), a failed request throws:
// an empty answer must never overwrite the saved thread.
async function threadPage(session, L, R, size, start) {
  const q = new URLSearchParams({ localNumber: L, remoteNumber: R, page_size: String(size) });
  if (start) q.set('start_key', start);
  const r = await api(session, `/messaging?${q}`);
  if (!r.ok) throw new Error(`messages: HTTP ${r.status}`);
  return { data: r.body?.data ?? [], next: r.body?.next_start_key ?? null };
}

async function fullThread(session, L, R) {
  const out = [], seen = new Set();
  let start = null;
  for (let p = 0; p < 20; p++) {
    const { data, next } = await threadPage(session, L, R, 200, start);
    for (const m of data) if (!seen.has(m.id)) { seen.add(m.id); out.push(norm(m)); }
    start = next;
    if (!start) break;
  }
  out.sort(byTime);
  cache.putThread(session, L, R, { messages: out, fullAt: Date.now() });
  return out;
}

// How many messages the last conversation list said this thread has.
function listedCount(session, L, R) {
  for (const k of ['', L]) {
    const c = cache.getList(session, k)?.conversations?.find(c => c.line === L && c.remote === R);
    if (c) return c.count;
  }
  return 0;
}

// A thread: the first time in full, afterwards only the newest page(s) until
// they reach a message already saved (the platform returns newest first, and a
// full fetch of a long thread takes ~13 s against ~0.6 s for one small page).
// The newest page is re-read every time, so delivery states stay current.
// cached: answer from the saved copy only (null if never fetched).
const PAGE = 25;
export async function thread(session, { line, remote, cached = false }) {
  const L = myLine(line);
  const R = e164(remote);
  if (!R) throw new Error('bad number');
  const have = cache.getThread(session, L, R);
  if (cached) return have?.messages ?? null;
  if (!have) return fullThread(session, L, R);

  const known = new Set(have.messages.map(m => m.id));
  const fresh = [];
  let start = null, reached = false;
  for (let p = 0; p < 20 && !reached; p++) {
    const { data, next } = await threadPage(session, L, R, PAGE, start);
    for (const m of data) { fresh.push(norm(m)); if (known.has(m.id)) reached = true; }
    start = next;
    if (!start) { reached = true; break; }
  }
  if (!reached) return fullThread(session, L, R);   // far behind: start over

  const byId = new Map(have.messages.map(m => [m.id, m]));
  for (const m of fresh) byId.set(m.id, m);
  const merged = [...byId.values()].sort(byTime);
  // Fewer than the platform says there are (missed a gap, or deleted upstream
  // since): refetch in full, at most every 10 minutes.
  const listed = listedCount(session, L, R);
  if (listed && merged.length !== listed && Date.now() - (have.fullAt || 0) > 10 * 60e3) return fullThread(session, L, R);
  cache.putThread(session, L, R, { messages: merged, fullAt: have.fullAt || 0 });
  return merged;
}

export async function fetchMedia(session, id, line) {
  if (!safeMediaId(id)) throw new Error('bad media id');
  const L = myLine(line);
  const base = derived().mediaServer;
  if (!base) throw new Error('No media server is set.');
  const r = await fetch(`${base.replace(/\/*$/, '/')}${id}/raw?localNumber=${encodeURIComponent(L)}`,
    { headers: { 'X-Auth-Token': session.auth_token } });
  if (!r.ok) throw new Error(`media fetch failed (${r.status})`);
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? 'application/octet-stream' };
}

// media: ids from uploadAttachment(). With media, the text may be empty.
// clientMsgId: the page's id for this draft, reused if the send is retried.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function sendText(session, { line, to, text, media = [], clientMsgId = null }) {
  const L = myLine(line);
  const T = e164(to);
  const body = String(text ?? '').trim();
  if (!Array.isArray(media) || media.length > MMS_MAX_FILES || !media.every(safeMediaId))
    throw new Error(`attachments are invalid (at most ${MMS_MAX_FILES})`);
  if (!T) throw new Error('enter a full phone number');
  if (!body && !media.length) throw new Error('message is empty');
  if (body.length > MAX_TEXT) throw new Error(`message is over ${MAX_TEXT} characters`);
  const cid = UUID.test(String(clientMsgId ?? '')) ? clientMsgId : null;
  const r = await sendMessage(session, { to: T, text: body, localNumber: L, media, clientMsgId: cid, dryRun: false });
  if (!r.ok) throw new Error(`send failed (HTTP ${r.status})`);
  // The platform answers with the thread's newest page; ours is the one with our clientMsgId.
  const sentId = r.body.data.clientMsgId;
  const sent = (Array.isArray(r.response?.data) ? r.response.data : [r.response?.data]).find(m => m?.clientMsgId === sentId);
  return { ok: true, id: sent?.id ?? null };
}

// What a file's bytes start with, per allowed type, so a renamed file can't
// pass as something else.
const SNIFF = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/pjpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'video/mp4': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'audio/wav': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE',
  'audio/ogg': (b) => b.subarray(0, 4).toString('latin1') === 'OggS',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};
const THUMB = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const THUMB_MAX = 3e6;   // characters of data URL (a 256 px PNG is far smaller)

// One attachment for a picture message, uploaded ahead of the message itself.
// thumb: a PNG data URL made by the page, or null (the platform accepts none).
export async function uploadAttachment(session, { line, name, type, data, thumb = null }) {
  const L = myLine(line);
  const t = String(type ?? '').toLowerCase();
  const n = String(name ?? '');
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 ? n.slice(dot).toLowerCase() : '';
  if (!MMS_TYPES[t]?.includes(ext)) throw new Error('that kind of file can’t be sent by text');
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('the file is empty');
  if (data.length > MMS_MAX_BYTES) throw new Error('the file is over 2 MB');
  if (!SNIFF[t](data)) throw new Error('the file doesn’t match its type');
  if (thumb != null && (typeof thumb !== 'string' || thumb.length > THUMB_MAX || !THUMB.test(thumb)))
    throw new Error('the attachment preview is invalid');
  const r = await uploadMedia(session, { localNumber: L, type: t, extension: ext, data, thumb: thumb || null, dryRun: false });
  return { id: r.id };
}

// Deletes from a conversation the way the platform's own app decides it.
// With mediaId: that photo (or other attachment) alone if the message also has
// text or other attachments, else the whole message. Without: the message,
// attachments and all. The message must be in the saved copy of this
// conversation, which is then updated to match. Answers the media ids removed.
export async function deleteMedia(session, { line, remote, messageId, mediaId = null }) {
  const L = myLine(line);
  const R = e164(remote);
  if (!R) throw new Error('bad number');
  if ((mediaId != null && !safeMediaId(mediaId)) || !safeMediaId(messageId)) throw new Error('bad id');
  const have = cache.getThread(session, L, R);
  const m = have?.messages?.find(x => x.id === messageId);
  if (!m || (mediaId != null && !m.media.some(x => x.id === mediaId)))
    throw new Error('that isn’t in this conversation any more (refresh and try again)');
  const whole = mediaId == null || (m.media.length === 1 && !m.text);
  const r = whole ? await deleteMessages(session, { ids: [messageId], localNumber: L })
    : await deleteAttachment(session, { mediaId, messageId });
  if (!r.ok) throw new Error(`delete failed (HTTP ${r.status})`);
  const messages = whole ? have.messages.filter(x => x.id !== messageId)
    : have.messages.map(x => x.id === messageId ? { ...x, media: x.media.filter(md => md.id !== mediaId) } : x);
  cache.putThread(session, L, R, { ...have, messages });
  return { ok: true, removed: whole ? 'message' : 'attachment', media: whole ? m.media.map(x => x.id) : [mediaId] };
}

// Deletes a whole conversation (one call, as the platform's app does) and
// drops it from the saved copies. Answers the media ids it had.
export async function deleteConversation(session, { line, remote }) {
  const L = myLine(line);
  const R = e164(remote);
  if (!R) throw new Error('bad number');
  const media = (cache.getThread(session, L, R)?.messages ?? []).flatMap(m => m.media.map(x => x.id));
  const r = await deleteThread(session, { remotes: [R], localNumber: L });
  if (!r.ok) throw new Error(`delete failed (HTTP ${r.status})`);
  cache.putThread(session, L, R, { messages: [], fullAt: 0 });
  for (const k of ['', L]) {
    const list = cache.getList(session, k)?.conversations;
    if (list) cache.putList(session, k, list.filter(c => !(c.line === L && c.remote === R)));
  }
  return { ok: true, media };
}

// A conversation as CSV (UTF-8 with a BOM so Excel reads it right): every
// message, oldest first, with who sent it and what was attached.
export async function conversationCsv(session, { line, remote }) {
  const L = myLine(line);
  const R = e164(remote);
  if (!R) throw new Error('bad number');
  const msgs = await thread(session, { line: L, remote: R });
  const c = loadContacts()[R];
  const them = c?.name ? `${c.name} (${R})` : R;
  // Quoted, and a leading = + - @ (a formula to a spreadsheet, e.g. in a text
  // someone sent) made plain text; a bare phone number is left as it is.
  const q = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s) && !/^\+\d+$/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const pad = (n) => String(n).padStart(2, '0');
  const kind = (mime) => mime === 'application/pdf' ? 'PDF' : String(mime).split('/')[0] || 'file';
  const rows = [['Date', 'Time', 'Direction', 'From', 'To', 'Message', 'Attachments', 'Status']];
  for (const m of msgs) {
    const d = new Date(m.at);
    rows.push([
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      m.inbound ? 'Received' : 'Sent', m.inbound ? them : L, m.inbound ? L : them, m.text,
      m.media.map(x => kind(x.mime)).join(', '), m.failed ? 'Failed' + (m.reason ? ': ' + m.reason : '') : m.state,
    ]);
  }
  return { csv: '\ufeff' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n', name: c?.name || R };
}
