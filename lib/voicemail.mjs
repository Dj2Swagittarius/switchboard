// Voicemail: list, fetch audio, transcribe locally, summarize.
// Transcripts are cached to disk — voicemail audio never changes once recorded.
import { api } from './kazoo.mjs';
import { whisper, llmJson } from './stt.mjs';
import { swr } from './cache.mjs';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dataPath } from './paths.mjs';

const CACHE = dataPath('vm-cache.json');
const NL = String.fromCharCode(10);
const GREG = 62167219200;

const readCache = () => existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const writeCache = (c) => writeFileSync(CACHE, JSON.stringify(c, null, 2));

// Finding our boxes means listing every box on the tenant (~1.4s). Box ids
// don't change, so hold the answer for ten minutes.
export function myBoxes(session) {
  return swr('vmboxes:' + session.owner_id, 10 * 60e3, async () => {
    const all = (await api(session, '/vmboxes')).body?.data ?? [];
    return all.filter(b => b.owner_id === session.owner_id);
  });
}

export async function listVoicemails(session) {
  const boxes = await myBoxes(session);
  const cache = readCache();
  const out = [];
  for (const box of boxes) {
    const msgs = (await api(session, `/vmboxes/${box.id}/messages`)).body?.data ?? [];
    for (const m of msgs) {
      out.push({
        box_id: box.id, mailbox: box.mailbox, media_id: m.media_id,
        from: m.caller_id_number, name: m.caller_id_name ?? '',
        folder: m.folder,
        seconds: Math.round((m.length ?? 0) / 1000),   // length is milliseconds
        at: (Number(m.timestamp) - GREG) * 1000,
        cached: !!cache[m.media_id],
        ...(cache[m.media_id] ?? {}),
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function fetchVoicemailAudio(session, boxId, mediaId) {
  const url = `${session.base}/v2/accounts/${session.account_id}/vmboxes/${boxId}/messages/${mediaId}/raw`;
  const r = await fetch(url, { headers: { 'X-Auth-Token': session.auth_token } });
  if (!r.ok) throw new Error(`audio fetch failed (${r.status})`);
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? 'audio/mpeg' };
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    caller_wants: { type: 'string' },
    urgency: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    callback_needed: { type: 'boolean' },
    site_or_job: { type: 'string' },
  },
  required: ['summary', 'caller_wants', 'urgency', 'callback_needed', 'site_or_job'],
  additionalProperties: false,
};

const SYSTEM = `You summarize a voicemail for a field-service dispatcher.
The transcript comes from automatic speech recognition and WILL contain errors,
especially in names, places, and equipment terms. Do not correct or invent them
— if a word is garbled, say so rather than guessing.

- summary: 1-2 sentences on what was said.
- caller_wants: the concrete ask, or "unclear".
- site_or_job: the location or job mentioned, verbatim from the transcript,
  or "" if none. Do not normalize a garbled place name into a real one.
- urgency: urgent only if someone is on site, blocked, or waiting now.`;

export async function transcribeVoicemail(session, boxId, mediaId, { force = false } = {}) {
  const cache = readCache();
  if (!force && cache[mediaId]) return cache[mediaId];

  const { buf } = await fetchVoicemailAudio(session, boxId, mediaId);
  const t = await whisper(buf);

  let summary = null, summaryError = null;
  try {
    summary = await llmJson({ system: SYSTEM, name: 'vm', schema: SCHEMA,
      user: 'Voicemail transcript:' + NL + '"""' + t.text + '"""' });
  } catch (e) { summaryError = e.message; }

  const entry = { text: t.text, language: t.language, duration: t.duration,
                  whisper: t.model, summary, summaryError,
                  transcribed_at: new Date().toISOString() };
  const fresh = readCache();
  fresh[mediaId] = entry;
  writeCache(fresh);
  return entry;
}
