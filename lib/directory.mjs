// Merged contact directory.
//
// contacts.json holds what you have labelled. Everything else is derived from
// traffic: message counterparties, CDR caller IDs, voicemail caller IDs. The
// phone system already knows many names (caller_id_name), so those are offered
// as suggestions rather than silently written into your roster.
//
// Speed: the traffic side is slow (call records alone take ~7s upstream), so
// the three sources are fetched in parallel and the aggregate is cached with
// stale-while-revalidate. The roster is merged fresh on every request, so a
// label you just saved always shows, even when traffic numbers are cached.
import { fetchAll } from './pipeline.mjs';
import { load as loadContacts, save as saveContacts } from './contacts.mjs';
import { listVoicemails } from './voicemail.mjs';
import { rawCdrs } from './calls.mjs';
import { lines } from './lines.mjs';
import { swr } from './cache.mjs';
import { connected } from './kazoo.mjs';

const GREG = 62167219200;
// Carrier-supplied CNAM is often a placeholder rather than a person.
const GENERIC_NAME = /^(wireless caller|unknown|unavailable|private|toll ?free|anonymous|no name|cell phone|v?o?ip)$/i;

const key = (n) => {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.length >= 10 ? '+' + (d.length === 10 ? '1' + d : d) : null;
};

const blank = () => ({
  messages: 0, calls: 0, voicemails: 0, lastSeen: 0,
  suggestedNames: {}, inbound: 0, outbound: 0,
});

async function buildTraffic(session, days) {
  const since = Date.now() - days * 864e5;
  // Our own lines are not contacts — they show up on both ends of CDRs.
  const mine = new Set(lines({ activeOnly: false }).map(l => key(l.number)).filter(Boolean));
  const acc = new Map();
  const bump = (num) => {
    const k = key(num);
    if (!k || mine.has(k)) return null;
    if (!acc.has(k)) acc.set(k, blank());
    return acc.get(k);
  };
  const suggest = (rec, name) => {
    const n = String(name ?? '').trim();
    if (!n || /^\+?\d+$/.test(n) || GENERIC_NAME.test(n)) return;
    rec.suggestedNames[n] = (rec.suggestedNames[n] ?? 0) + 1;
  };

  // One slow source shouldn't sink the others: each failure yields empty.
  const [msgs, cdrs, vms] = await Promise.all([
    fetchAll(session).then(r => r.all).catch(() => []),
    rawCdrs(session).catch(() => []),
    listVoicemails(session).catch(() => []),
  ]);

  for (const m of msgs) {
    if (m.at < since) continue;
    const r = bump(m.remote);
    if (!r) continue;
    r.messages++;
    if (m.inbound) r.inbound++; else r.outbound++;
    r.lastSeen = Math.max(r.lastSeen, m.at);
  }

  for (const c of cdrs) {
    const at = Number(c.unix_timestamp ?? (Number(c.timestamp) - GREG)) * 1000;
    if (at < since) continue;
    const other = c.direction === 'inbound' ? c.caller_id_number : c.callee_id_number;
    const r = bump(other);                         // internal extensions fall out here
    if (!r) continue;
    r.calls++;
    r.lastSeen = Math.max(r.lastSeen, at);
    suggest(r, c.caller_id_name);
  }

  for (const v of vms) {
    const r = bump(v.from);
    if (!r) continue;
    r.voicemails++;
    r.lastSeen = Math.max(r.lastSeen, v.at);
    suggest(r, v.name);
  }

  return [...acc.entries()];
}

export async function directory(session, { days = 365 } = {}) {
  // Not signed in to an account (or phone only): no traffic to read, and no
  // upstream calls. The book is then just the roster.
  const traffic = connected(session)
    ? await swr(`dir:traffic:${session.owner_id}:${days}`, 60e3, () => buildTraffic(session, days))
    : [];
  const roster = loadContacts();
  const seen = new Set();

  const row = (number, s) => {
    const c = roster[number] ?? null;
    const names = Object.entries(s.suggestedNames).sort((a, b) => b[1] - a[1]);
    return {
      number,
      name: c?.name ?? '',
      role: c?.role ?? 'unknown',
      note: c?.note ?? '',
      labelled: !!(c && (c.name || (c.role && c.role !== 'unknown'))),
      suggestedName: names[0]?.[0] ?? '',
      activity: { messages: s.messages, inbound: s.inbound, outbound: s.outbound,
                  calls: s.calls, voicemails: s.voicemails, lastSeen: s.lastSeen },
    };
  };

  const out = [];
  for (const [number, s] of traffic) { seen.add(number); out.push(row(number, s)); }
  // Anything labelled but not seen in traffic still belongs in the book.
  for (const number of Object.keys(roster)) {
    const k = key(number);
    if (k && !seen.has(k)) { seen.add(k); out.push(row(k, blank())); }
  }

  out.sort((a, b) => (b.activity.lastSeen || 0) - (a.activity.lastSeen || 0));
  return out;
}

export function upsert({ number, name, role, note }) {
  const k = key(number);
  if (!k) throw new Error('number must have at least 10 digits');
  const roster = loadContacts();
  roster[k] = {
    name: name ?? roster[k]?.name ?? '',
    role: role ?? roster[k]?.role ?? 'unknown',
    note: note ?? roster[k]?.note ?? '',
  };
  saveContacts(roster);
  return roster[k];
}

export function remove(number) {
  const k = key(number);
  const roster = loadContacts();
  delete roster[k];
  saveContacts(roster);
  return true;
}
