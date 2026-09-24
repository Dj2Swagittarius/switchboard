// Shared ingest -> vision -> triage -> queue pipeline.
// Used by both bot.mjs (CLI) and server.mjs (dashboard).
import { api } from './kazoo.mjs';
import { normalize } from './message.mjs';
import { enrich } from './media.mjs';
import { triage } from './llm.mjs';
import { lookup } from './contacts.mjs';
import { lines } from './lines.mjs';
import * as store from './store.mjs';
import * as settings from './settings.mjs';

export async function fetchAll(session) {
  const raw = [];
  for (const l of lines()) {
    const r = await api(session, `/messaging?localNumber=${encodeURIComponent(l.number)}`);
    raw.push(...(r.body?.data ?? []));
  }
  const rawById = new Map(raw.map(r => [r.id, r]));
  const all = raw.map(normalize).sort((a, b) => a.at - b.at);
  const threads = new Map();
  for (const m of all) {
    if (!threads.has(m.remote)) threads.set(m.remote, []);
    threads.get(m.remote).push(m);
  }
  return { all, rawById, threads };
}

// A new text as a plain notification: who and what, no AI.
const plain = (m) => ({
  id: m.id, remote: m.remote, local: m.local, at: m.at, name: lookup(m.remote)?.name ?? '',
  preview: m.text.trim() || (m.media.length ? 'Sent a photo' : 'New message'),
});

// Processes new inbound messages. `skip` holds ids deliberately not processed
// (startup backlog) so later passes don't pick them up.
//
// With triage off (no AI platform wanted) new messages are only announced:
// onMessage gets a plain preview for the notification and the id joins `skip`.
// Nothing goes into the triage queue. A text that triage can't handle (AI
// down) is announced the same way, once, so it isn't silently missed.
//
// Plain announcements only cover texts newer than `mark`, the newest inbound
// time the previous pass saw (null on the first pass: announce nothing, just
// set it). Backlogs, re-scans after a line is switched on and old texts that
// failed triage therefore never announce as new. `notified` holds the ids
// already announced, so nothing is announced twice.
export async function runOnce(session, { backlog = null, skip = new Set(), onItem = null,
                                         triage: withAi = true, onMessage = null,
                                         mark = null, notified = new Set() } = {}) {
  const { all, rawById, threads } = await fetchAll(session);
  const newest = all.reduce((n, m) => (m.inbound && m.at > n ? m.at : n), mark ?? 0);
  const isNews = (m) => mark !== null && m.at > mark && !notified.has(m.id);
  const announce = (m) => { notified.add(m.id); const msg = plain(m); onMessage?.(msg); return msg; };
  let fresh = all.filter(m => m.inbound && !store.has(m.id) && !skip.has(m.id));

  if (backlog !== null) {
    const keep = backlog > 0 ? fresh.slice(-backlog) : [];
    for (const m of fresh) if (!keep.includes(m)) skip.add(m.id);
    fresh = keep;
  }

  const done = [];
  if (!withAi) {
    for (const m of fresh) {
      skip.add(m.id);
      if (isNews(m)) done.push(announce(m));
    }
    return { processed: done, scanned: all.length, newest };
  }
  for (const m of fresh) {
    if (m.media.length && settings.get('triage.describePhotos')) await enrich(session, m, rawById.get(m.id)?.media);
    const thread = threads.get(m.remote) ?? [];
    const history = thread.slice(Math.max(0, thread.indexOf(m) - 4), thread.indexOf(m));
    const contact = lookup(m.remote);
    let r;
    try { r = await triage(m, { history, knownRole: contact?.role }); }
    catch (e) {
      // Still retried next pass; meanwhile the person hears about the text.
      done.push({ id: m.id, error: e.message });
      if (isNews(m)) announce(m);
      continue;
    }

    // `announced`: a plain notification already went out (triage failed on
    // an earlier pass), so the app doesn't raise a second one for it.
    const entry = { id: m.id, remote: m.remote, local: m.local, at: m.at,
                    text: m.forModel(), name: contact?.name ?? '', ...r, announced: notified.has(m.id) };
    store.add(entry);
    done.push(entry);
    onItem?.(entry);
  }
  return { processed: done, scanned: all.length, newest };
}
