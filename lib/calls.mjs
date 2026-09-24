// Call history, recording playback, and recording transcription.
//
// Kazoo writes one CDR per call *leg*, and each leg's `direction` is from that
// leg's point of view — an incoming call to you appears as an "outbound" leg
// from the platform to your device. So calls are grouped by interaction and
// the real direction is derived from which side your own numbers are on.
import { api } from './kazoo.mjs';
import { lines } from './lines.mjs';
import { load as loadContacts } from './contacts.mjs';
import { whisper, llmJson } from './stt.mjs';
import { swr } from './cache.mjs';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const CACHE = new URL('../rec-cache.json', import.meta.url);
const GREG = 62167219200;
const NL = String.fromCharCode(10);
const GENERIC = /^(wireless caller|unknown|unavailable|private|toll ?free|anonymous|no name|cell phone)$/i;

const digits = (n) => String(n ?? '').replace(/\D/g, '');
const last10 = (n) => digits(n).slice(-10);
const external = (n) => digits(n).length >= 10;
const readCache = () => existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

// Recording and media ids are interpolated into upstream URLs; accept only
// plain id characters so nothing can steer the path.
export const safeId = (id) => /^[A-Za-z0-9_-]{8,80}$/.test(String(id ?? ''));

async function mine(session) {
  if (!session._mine) {
    const me = (await api(session, `/users/${session.owner_id}`)).body?.data ?? {};
    session._mine = new Set([
      ...lines({ activeOnly: false }).map(l => last10(l.number)),
      String(me.presence_id ?? ''),
    ].filter(Boolean));
  }
  return session._mine;
}

// Raw CDRs take ~7s upstream. Shared by call history, insights and the
// contact directory, so one fetch per minute serves all three.
export function rawCdrs(session) {
  return swr('cdrs:' + session.owner_id, 60e3, async () =>
    (await api(session, `/users/${session.owner_id}/cdrs?page_size=500`)).body?.data ?? []);
}

export async function listCalls(session, { days = 30 } = {}) {
  const since = Date.now() - days * 864e5;
  const own = await mine(session);
  const isMine = (n) => own.has(last10(n)) || own.has(digits(n));
  const roster = loadContacts();
  const cache = readCache();

  const cdrs = await rawCdrs(session);
  const groups = new Map();
  for (const c of cdrs) {
    const k = c.interaction_id || c.call_id || c.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }

  const out = [];
  for (const [id, legs] of groups) {
    const at = Math.min(...legs.map(c => Number(c.unix_timestamp ?? (Number(c.timestamp) - GREG)) * 1000));
    if (!(at >= since)) continue;

    // The other party: a number on any leg that isn't one of ours. Prefer an
    // external number over an internal extension.
    const candidates = legs.flatMap(c => [
      { n: c.caller_id_number, name: c.caller_id_name, caller: true },
      { n: c.callee_id_number, name: c.callee_id_name, caller: false },
      { n: c.dialed_number, name: '', caller: false },
    ]).filter(x => x.n && !isMine(x.n));
    const other = candidates.find(x => external(x.n)) ?? candidates[0] ?? { n: '', name: '', caller: false };

    // Connected = some leg has billed (bridged) time. Outbound calls you place
    // are logged SUCCESS, not ANSWER. Inbound calls ring every device in
    // parallel; the devices that didn't pick up log LOSE_RACE — those are not
    // missed calls, just the other phones that stopped ringing.
    const answered = legs.some(c => Number(c.billing_seconds ?? 0) > 0 && c.hangup_cause !== 'LOSE_RACE');
    const recording = legs.flatMap(c => c.media_recordings ?? [])[0] ?? null;
    const key = external(other.n) ? '+1' + last10(other.n) : String(other.n);
    const contact = roster[key];
    const cnam = String(other.name ?? '').trim();

    out.push({
      id, at,
      direction: other.caller ? 'in' : 'out',
      number: other.n ? key : '',
      internal: !external(other.n),
      name: contact?.name || (cnam && !GENERIC.test(cnam) && !/^\+?\d+$/.test(cnam) ? cnam : ''),
      role: contact?.role ?? '',
      seconds: Math.max(0, ...legs.map(c => Number(c.duration_seconds ?? 0))),
      answered,
      recording,
      transcript: recording ? cache[recording] ?? null : null,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function fetchRecordingAudio(session, recId) {
  const url = `${session.base}/v2/accounts/${session.account_id}/recordings/${recId}`;
  const r = await fetch(url, { headers: { 'X-Auth-Token': session.auth_token, Accept: 'audio/mpeg' } });
  if (!r.ok) throw new Error(`recording fetch failed (${r.status})`);
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? 'audio/mpeg' };
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    outcome: { type: 'string' },
    follow_ups: { type: 'array', items: { type: 'string' } },
    site_or_job: { type: 'string' },
    tone: { type: 'string', enum: ['positive', 'neutral', 'tense'] },
  },
  required: ['summary', 'outcome', 'follow_ups', 'site_or_job', 'tone'],
  additionalProperties: false,
};

const SYSTEM = `You summarize a recorded phone call for a field-service
dispatcher. The transcript is automatic speech recognition of both sides with
no speaker labels, and WILL contain errors in names, places, and equipment
terms. Never correct or invent them.

- summary: 2-3 sentences on what the call was about.
- outcome: what was decided or left unresolved, in one sentence.
- follow_ups: concrete actions someone committed to. Empty array if none.
  Only include things actually said.
- site_or_job: location or job, verbatim from the transcript, or "".
- tone: tense only if there was clear frustration or conflict.`;

export async function transcribeRecording(session, recId, { force = false } = {}) {
  if (!force) { const hit = readCache()[recId]; if (hit) return hit; }
  const { buf } = await fetchRecordingAudio(session, recId);
  const t = await whisper(buf);

  let summary = null, summaryError = null;
  if (t.text.trim()) {
    try {
      summary = await llmJson({ system: SYSTEM, name: 'call', schema: SCHEMA,
        user: 'Call transcript:' + NL + '"""' + t.text + '"""' });
    } catch (e) { summaryError = e.message; }
  }

  const entry = { text: t.text, duration: t.duration, whisper: t.model,
                  summary, summaryError, transcribed_at: new Date().toISOString() };
  const fresh = readCache();
  fresh[recId] = entry;
  writeFileSync(CACHE, JSON.stringify(fresh, null, 2));
  return entry;
}
