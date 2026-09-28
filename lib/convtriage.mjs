// Triage of whole conversations (one outside number), kept as one queue entry
// per conversation (id "c:" + its last 10 digits) in lib/store.mjs.
//
// analyze() reads the conversation's full thread and either runs triage now
// or, in connector mode, leaves it "awaiting triage" with the transcript for
// the Claude app. Whether the entry sits in the queue (unresolved) is up to
// the caller: new texts reopen it, our reply closes it (closeReplied).
import * as store from './store.mjs';
import * as photonotes from './photonotes.mjs';
import * as ai from './ai.mjs';
import { thread } from './messaging.mjs';
import { lookup } from './contacts.mjs';
import { triageConversation } from './llm.mjs';

export const AWAITING = 'awaiting_triage';
const MAX = 40;
const NL = String.fromCharCode(10);
const ten = (n) => String(n ?? '').replace(/\D/g, '').slice(-10);
const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const convId = (remote) => 'c:' + ten(remote);
export const isConv = (e) => String(e?.id ?? '').startsWith('c:');
export const get = (remote) => store.all().find(e => e.id === convId(remote)) ?? null;

// One message as the model reads it. Photos use their saved descriptions.
export function say(m, notes = {}) {
  const body = String(m.text ?? '').trim();
  const n = (m.media ?? []).length;
  if (!n) return body || '(empty message)';
  const d = notes[m.id];
  const att = d?.length ? d.map((x, i) => `[image ${i + 1}: ${x}]`).join(' ')
                        : `[${n} photo${n === 1 ? '' : 's'} attached]`;
  return body ? body + ' ' + att : att;
}

export const transcript = (msgs, notes = {}) =>
  msgs.slice(-MAX).map(m => `${stamp(m.at)} ${m.inbound ? 'THEM' : 'US'}: ${say(m, notes)}`).join(NL);

// Their texts since our last reply (the newest 5), for the queue card.
export function recent(msgs, notes = {}) {
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].inbound) i--;
  return msgs.slice(i).slice(-5).map(m => ({ at: m.at, text: say(m, notes) }));
}

const newest = (msgs) => msgs[msgs.length - 1] ?? null;
export const replied = (msgs) => { const n = newest(msgs); return !!n && !n.inbound; };
export const stale = (entry, msgs) => { const n = newest(msgs); return !entry || (!!n && n.at > (entry.through_at ?? 0)); };

// Photos the Claude app can ask for through /api/connector/media.
const photoRefs = (msgs) => msgs.slice(-MAX).flatMap(m => (m.media ?? [])
  .filter(x => /^image\//.test(x.mime)).map((x, n) => ({ msg: m.id, n, media_id: x.id, mime: x.mime })));

// reopen: put it (back) in the queue. keepClosed (connector mode): asked for
// on request, so it leaves the queue again once Claude has answered.
// upTo: the newest text the caller knows of, in case the thread lags.
export async function analyze(session, { remote, line, name = '', upTo = 0, reopen = false, keepClosed = false }) {
  const msgs = await thread(session, { line, remote });
  const notes = photonotes.all();
  const contact = lookup(remote);
  const knownRole = contact?.role && contact.role !== 'unknown' ? contact.role : null;
  const last = newest(msgs);
  const base = {
    remote, local: line, name: contact?.name || name || '',
    at: last?.at ?? upTo, through_at: Math.max(last?.at ?? 0, upTo), through_id: last?.id ?? null,
    recent: recent(msgs, notes),
    ...(reopen ? { resolution: undefined, resolved_at: undefined } : {}),
  };
  if (ai.provider() === 'connector') {
    return store.upsert(convId(remote), { ...base, status: AWAITING, known_role: knownRole ?? 'unknown',
      transcript: msgs.slice(-MAX).map(m => ({ at: m.at, inbound: m.inbound, text: say(m, notes) })),
      photos: photoRefs(msgs), keep_closed: keepClosed || undefined });
  }
  const answer = await triageConversation(transcript(msgs, notes), { knownRole });
  return store.upsert(convId(remote), { ...base, ...answer, status: undefined, transcript: undefined,
    photos: undefined, known_role: undefined, keep_closed: undefined,
    triaged_by: 'app', triaged_at: new Date().toISOString() });
}

// Per-message entries from before conversation triage leave the queue.
export function migrate() {
  for (const e of store.pending()) if (!isConv(e)) store.resolve(e.id, 'merged');
}

// Open conversations whose newest message is ours: we replied, so they leave
// the queue. One asked of Claude on request stays until Claude answers.
// `threads` maps remote -> messages, oldest first. Returns how many closed.
export function closeReplied(threads) {
  const byTen = new Map([...threads].map(([r, msgs]) => [ten(r), msgs]));
  let n = 0;
  for (const e of store.pending()) {
    if (!isConv(e) || (e.status === AWAITING && e.keep_closed)) continue;
    const msgs = byTen.get(ten(e.remote));
    if (msgs && replied(msgs)) { store.resolve(e.id, 'replied'); n++; }
  }
  return n;
}
