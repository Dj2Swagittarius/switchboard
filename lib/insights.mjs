// Local analytics over messages, triage history, and call records.
// Pure arithmetic — no LLM call unless themes are explicitly requested.
import { api } from './kazoo.mjs';
import { fetchAll } from './pipeline.mjs';
import * as store from './store.mjs';
import { listCalls } from './calls.mjs';

// Kazoo timestamps are Gregorian seconds; unix_timestamp is present on CDRs.
const GREG_OFFSET = 62167219200;
const toMs = (cdr) => Number(cdr.unix_timestamp ?? (Number(cdr.timestamp) - GREG_OFFSET)) * 1000;

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const tally = (arr, fn) => {
  const m = {};
  for (const x of arr) { const k = fn(x); if (k != null) m[k] = (m[k] ?? 0) + 1; }
  return m;
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const topN = (obj, n = 8) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

const external = (n) => /^\+?\d{10,15}$/.test(String(n ?? '').replace(/\D/g, '')) &&
  String(n).replace(/\D/g, '').length >= 10;

export async function insights(session, { days = 30 } = {}) {
  const since = Date.now() - days * 864e5;

  // --- messages -----------------------------------------------------------
  const { all, threads } = await fetchAll(session);
  const msgs = all.filter(m => m.at >= since);
  const inbound = msgs.filter(m => m.inbound);
  const outbound = msgs.filter(m => !m.inbound);

  // Reply latency: each inbound answered by the next outbound in its thread.
  // Capped at 24h — beyond that it is a new conversation, not a slow reply,
  // and pairing across months produces meaningless medians.
  const REPLY_WINDOW = 24 * 3600e3;
  const latencies = [];
  let unanswered = 0;
  for (const [, thread] of threads) {
    for (let i = 0; i < thread.length; i++) {
      if (!thread[i].inbound) continue;
      const reply = thread.slice(i + 1).find(m => !m.inbound);
      const gap = reply ? reply.at - thread[i].at : Infinity;
      if (gap > 0 && gap <= REPLY_WINDOW) latencies.push(gap);
      else unanswered++;
    }
  }

  const withMedia = inbound.filter(m => m.media.length).length;

  // --- triage history -----------------------------------------------------
  const queue = store.all();
  const resolved = queue.filter(e => e.resolution);

  // --- calls --------------------------------------------------------------
  // Calls come from lib/calls.mjs, which groups per-leg CDRs into real calls.
  // Counting raw legs inflated both totals and "missed": every inbound call
  // rings all devices, and each device that didn't pick up logs LOSE_RACE.
  let cdrs = [];
  try {
    cdrs = (await listCalls(session, { days })).map(c => ({
      at: c.at,
      dir: c.direction === 'in' ? 'inbound' : 'outbound',
      secs: c.seconds,
      answered: c.answered,
      who: c.number,
      name: c.name,
      recorded: !!c.recording,
    }));
  } catch {}

  const answered = cdrs.filter(c => c.answered);

  return {
    window: { days, since: new Date(since).toISOString() },
    messages: {
      total: msgs.length, inbound: inbound.length, outbound: outbound.length,
      withMedia,
      byDay: tally(msgs, m => dayKey(m.at)),
      byHour: tally(msgs, m => new Date(m.at).getHours()),
      topContacts: topN(tally(inbound, m => m.remote)),
      medianReplyMs: median(latencies),
      repliedWithin24h: latencies.length,
      unanswered,
      threads: threads.size,
    },
    triage: {
      queued: queue.length, pending: queue.length - resolved.length,
      sent: resolved.filter(e => e.resolution === 'sent').length,
      dismissed: resolved.filter(e => e.resolution === 'rejected').length,
      byCategory: tally(queue, e => e.category),
      byUrgency: tally(queue, e => e.urgency),
      byRole: tally(queue, e => e.from_role),
      needsHumanRate: queue.length ? queue.filter(e => e.needs_human).length / queue.length : null,
    },
    calls: {
      total: cdrs.length,
      answered: answered.length,
      missed: cdrs.length - answered.length,
      inbound: cdrs.filter(c => c.dir === 'inbound').length,
      outbound: cdrs.filter(c => c.dir === 'outbound').length,
      recorded: cdrs.filter(c => c.recorded).length,
      totalMinutes: Math.round(cdrs.reduce((s, c) => s + c.secs, 0) / 60),
      medianSecs: median(answered.map(c => c.secs)),
      byDay: tally(cdrs, c => dayKey(c.at)),
      byHour: tally(cdrs, c => new Date(c.at).getHours()),
      topCallers: topN(tally(cdrs.filter(c => c.dir === 'inbound' && external(c.who)), c => c.who)),
    },
  };
}
