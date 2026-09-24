// Fax: received and sent faxes, and sending one, for THIS user's fax box only.
//
// The account's fax endpoints are company-wide (every coworker's fax box and
// their faxes), so nothing here is ever listed unfiltered: received faxes are
// kept when their faxbox_id is one of the user's own boxes, sent faxes when
// they went out from one of those boxes' numbers (outbox records carry no
// faxbox_id). A PDF is only served after the same ownership check.
//
// Sending: PUT /faxes (the account's fax root) with a multipart/mixed body
// (JSON details, then the PDF). PUT /faxes/outbox is advertised in CORS but
// answers 405 invalid_method on this platform; PUT /faxes reaches validation
// (from_number required). The provider's error text is passed back if it refuses.
import { api } from './kazoo.mjs';
import { swr } from './cache.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Faxes sent from this app are jobs whose document the platform won't hand
// back (every attachment request answers 404/406), so the app keeps its own
// copy of each PDF it sends: faxes/sent/<job id>.pdf in the app folder.
const SENT_DIR = new URL('../faxes/sent/', import.meta.url);
const sentFile = (id) => new URL(`${id}.pdf`, SENT_DIR);
export const hasSentCopy = (id) => safeFaxId(id) && existsSync(sentFile(id));
function keepSentCopy(id, buf) {
  if (!safeFaxId(id)) return;
  try { mkdirSync(SENT_DIR, { recursive: true }); writeFileSync(sentFile(id), buf); } catch {}
}

const GREG = 62167219200;
const digits10 = (n) => String(n ?? '').replace(/\D/g, '').slice(-10);
export const e164 = (n) => {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.length === 10 ? '+1' + d : d.length >= 11 && d.length <= 15 ? '+' + d : null;
};
export const safeFaxId = (id) => /^[A-Za-z0-9_-]{6,80}$/.test(String(id ?? ''));
// Kazoo timestamps are Gregorian seconds; accept unix seconds/ms too.
const when = (t) => {
  const n = Number(t);
  if (!n) return 0;
  if (n > 1e12) return n;
  return (n > GREG ? n - GREG : n) * 1000;
};

// The user's own fax boxes: id, display name, fax number.
export function myBoxes(session) {
  return swr(`faxboxes:${session.owner_id}`, 10 * 60e3, async () => {
    const r = await api(session, '/faxboxes');
    if (!r.ok) throw new Error(`fax boxes: HTTP ${r.status}`);
    return (r.body?.data ?? []).filter(b => b.owner_id === session.owner_id).map(b => ({
      id: b.id, name: String(b.name ?? ''), number: String(b.fax_identity || b.caller_id || ''),
      callerName: String(b.caller_name || ''),
    }));
  });
}

// Every page of a fax folder (they're small, but paged like everything else).
async function folder(session, name) {
  const out = [];
  let start = null;
  for (let p = 0; p < 10; p++) {
    const q = new URLSearchParams({ page_size: '200' });
    if (start) q.set('start_key', start);
    const r = await api(session, `/faxes/${name}?${q}`);
    if (!r.ok) throw new Error(`fax ${name}: HTTP ${r.status}`);
    out.push(...(r.body?.data ?? []));
    start = r.body?.next_start_key ?? null;
    if (!start) break;
  }
  return out;
}

const mineIn = (boxes) => { const ids = new Set(boxes.map(b => b.id)); return (f) => ids.has(f.faxbox_id); };
const mineOut = (boxes) => {
  const nums = new Set(boxes.map(b => digits10(b.number)).filter(Boolean));
  return (f) => nums.has(digits10(f.from_number)) || nums.has(digits10(f.fax_identity_number));
};

// A sent fax's status for the page: queued, retrying (an attempt failed and
// more are allowed), sending, sent or failed.
function sentStatus(status, attempts, tx) {
  const s = String(status || (tx ? (tx.success ? 'completed' : 'failed') : 'pending'));
  if (s === 'pending' && attempts > 0 && tx && tx.success === false) return 'retrying';
  return s;
}

export async function faxes(session) {
  const boxes = await myBoxes(session);
  if (!boxes.length) return { boxes: [], inbox: [], outbox: [] };
  const ids = new Set(boxes.map(b => b.id));
  // Faxes sent from this app are jobs in /faxes/outgoing, tagged with the fax
  // box; the outbox holds the ones sent from the web portal or by email.
  const [rx, tx, jobs] = await Promise.all([folder(session, 'inbox'), folder(session, 'outbox'), folder(session, 'outgoing')]);
  const mineJobs = jobs.filter(j => ids.has(j.faxbox_id))
    .sort((a, b) => when(b.created) - when(a.created)).slice(0, 25);
  // The listing is thin (no result or recipient name); the few of our own are read in full.
  const jobDocs = await Promise.all(mineJobs.map(j => api(session, `/faxes/outgoing/${j.id}`)
    .then(r => ({ ...j, ...(r.body?.data ?? {}) })).catch(() => j)));
  const sentJobs = jobDocs.map(f => ({
    id: f.id, folder: 'outgoing', at: when(f.created),
    number: String(f.to_number ?? f.to ?? ''), name: String(f.to_name ?? ''),
    pages: f.tx_result?.pages_sent ?? null,
    status: sentStatus(f.status, Number(f.attempts ?? 0), f.tx_result),
    detail: String(f.tx_result?.result_text ?? ''),
    attempts: Number(f.attempts ?? 0), retries: Number(f.retries ?? 0),
    hasPdf: hasSentCopy(f.id),          // only faxes sent from this app have a copy
  }));
  const inbox = rx.filter(mineIn(boxes)).map(f => ({
    id: f.id, at: when(f.timestamp ?? f.created),
    number: String(f.from_number ?? ''), name: String(f.from_name ?? ''),
    pages: f.rx_result?.pages_received ?? f.rx_result?.pages ?? null,
    ok: f.rx_result ? f.rx_result.success !== false : true,
    detail: String(f.rx_result?.result_text ?? ''),
    hasPdf: true,
  }));
  const seen = new Set(sentJobs.map(f => f.id));
  const outbox = tx.filter(mineOut(boxes)).filter(f => !seen.has(f.id)).map(f => ({
    id: f.id, folder: 'outbox', at: when(f.created ?? f.timestamp ?? f.ooma_timestamp),
    number: String(f.to_number ?? ''), name: String(f.to_name ?? ''),
    pages: f.tx_result?.pages_sent ?? null,
    status: sentStatus(f.status, Number(f.attempts ?? 0), f.tx_result),
    detail: String(f.tx_result?.result_text ?? ''),
    attempts: Number(f.attempts ?? 0), retries: Number(f.retries ?? 0),
    hasPdf: true,
  }));
  const byNewest = (a, b) => b.at - a.at;
  return {
    boxes: boxes.map(b => ({ name: b.name, number: b.number })),
    inbox: inbox.sort(byNewest), outbox: [...sentJobs, ...outbox].sort(byNewest),
  };
}

// Raw request with the session's token; a 401 re-authenticates through api()
// once and tries again.
async function raw(session, path, opts = {}, retry = true) {
  const url = `${session.base}/v2/accounts/${session.account_id}${path}`;
  const res = await fetch(url, { ...opts, headers: { 'X-Auth-Token': session.auth_token, ...opts.headers } });
  if (res.status === 401 && retry) { await api(session, '/faxboxes'); return raw(session, path, opts, false); }
  return res;
}

// The fax as a PDF, only if it belongs to one of the user's boxes.
export async function pdf(session, which, id) {
  if (!['inbox', 'outbox', 'outgoing'].includes(which) || !safeFaxId(id)) throw new Error('bad fax id');
  const boxes = await myBoxes(session);
  const doc = (await api(session, `/faxes/${which}/${id}`)).body?.data;
  const ok = doc && (which === 'outbox' ? mineOut(boxes)(doc) : mineIn(boxes)(doc));   // inbox + jobs carry faxbox_id
  if (!ok) throw new Error('not one of your faxes');
  const meta = { number: which === 'inbox' ? doc.from_number : doc.to_number, at: when(doc.timestamp ?? doc.created) };
  if (which === 'outgoing') {
    if (!hasSentCopy(id)) throw new Error('no copy of this fax');
    return { buf: readFileSync(sentFile(id)), type: 'application/pdf', ...meta };
  }
  // Accept must be */*: this platform answers "Accept: application/pdf" with 406.
  const res = await raw(session, `/faxes/${which}/${id}/attachment`, { headers: { Accept: '*/*' } });
  if (!res.ok) throw new Error(`fax document: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('the fax service didn’t return a PDF');
  return { buf, type: 'application/pdf', ...meta };
}

// Sends `file` (a PDF) to `to` from the user's fax box. Returns the new id.
export async function send(session, { to, toName = '', file }) {
  const T = e164(to);
  if (!T) throw new Error('Enter a full fax number.');
  if (!Buffer.isBuffer(file) || file.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Choose a PDF file.');
  const box = (await myBoxes(session))[0];
  if (!box) throw new Error('Your account has no fax box.');
  if (!box.number) throw new Error('Your fax box has no fax number.');
  const details = { data: {
    to_number: T, to_name: String(toName).slice(0, 60),
    from_number: box.number, from_name: box.callerName || box.name,
    faxbox_id: box.id, retries: 3,
  } };
  const boundary = 'sbfax' + crypto.randomUUID().replace(/-/g, '');
  const CRLF = '\r\n';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}${CRLF}Content-Type: application/json${CRLF}${CRLF}${JSON.stringify(details)}${CRLF}`),
    Buffer.from(`--${boundary}${CRLF}Content-Type: application/pdf${CRLF}${CRLF}`),
    file,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ]);
  const res = await raw(session, '/faxes', { method: 'PUT', body,
    headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.message || j?.data?.message || `the fax service refused it (HTTP ${res.status})`);
  const id = j?.data?.id ?? null;
  if (id) keepSentCopy(id, file);
  return { id, status: j?.data?.status ?? 'pending' };
}
