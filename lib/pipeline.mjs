// Shared ingest -> vision -> triage -> queue pipeline.
// Used by both bot.mjs (CLI) and server.mjs (dashboard).
import { api } from './kazoo.mjs';
import { normalize } from './message.mjs';
import { enrich } from './media.mjs';
import { lookup } from './contacts.mjs';
import { lines } from './lines.mjs';
import * as store from './store.mjs';
import * as settings from './settings.mjs';
import * as ai from './ai.mjs';
import * as convtriage from './convtriage.mjs';
import * as photonotes from './photonotes.mjs';

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

// Processes new inbound messages: each conversation with new texts is
// triaged as a whole (lib/convtriage.mjs), and open conversations we have
// since replied to leave the queue. `skip` holds ids deliberately not processed
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
  // New = newer than what its conversation's triage has seen. store.has():
  // texts triaged one by one before conversation triage.
  const through = new Map(store.all().filter(convtriage.isConv).map(e => [e.id, e.through_at ?? 0]));
  let fresh = all.filter(m => m.inbound && !skip.has(m.id) && !store.has(m.id) &&
    m.at > (through.get(convtriage.convId(m.remote)) ?? 0));

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
    return { processed: done, scanned: all.length, newest, closed: 0 };
  }
  const viaConnector = ai.provider() === 'connector';
  const groups = new Map();
  for (const m of fresh) {
    const k = convtriage.convId(m.remote);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  for (const [id, ms] of groups) {
    const last = ms[ms.length - 1];
    // New photos are described once; the Claude app looks at them itself.
    if (!viaConnector && settings.get('triage.describePhotos'))
      for (const m of ms) if (m.media.length && !photonotes.get(m.id)) {
        await enrich(session, m, rawById.get(m.id)?.media);
        photonotes.set(m.id, m.descriptions);
      }
    let entry;
    try {
      entry = await convtriage.analyze(session, { remote: last.remote, line: last.local,
        name: lookup(last.remote)?.name ?? '', upTo: last.at, reopen: true });
    } catch (e) {
      // Still retried next pass; meanwhile the person hears about the texts.
      done.push({ id, error: e.message });
      for (const m of ms) if (isNews(m)) announce(m);
      continue;
    }
    if (viaConnector) {
      // Triaged later by the Claude app; announced now as plain new texts.
      for (const m of ms) if (isNews(m)) announce(m);
      done.push(entry);
      continue;
    }
    // Already announced plainly (triage was failing): no second notification.
    entry = { ...entry, announced: ms.every(m => notified.has(m.id)) };
    done.push(entry);
    onItem?.(entry);
  }
  const closed = convtriage.closeReplied(threads);
  return { processed: done, scanned: all.length, newest, closed };
}
