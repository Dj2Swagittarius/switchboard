// Company directory and call park, read from the phone platform's account.
//
// Users come from /users; their extensions and direct numbers from the
// callflows that point at them (a user's callflow lists every number that
// rings them). Users the admin hid from the directory (contact_list.exclude)
// stay hidden here too.
//
// Park codes are read from the account's own feature-code callflows rather
// than assumed, so whatever the account uses is what the phone dials.
import { api } from './kazoo.mjs';
import { swr } from './cache.mjs';

const EXT = /^\d{2,6}$/;
const e164 = (n) => {
  const d = String(n ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length >= 11 && d.length <= 15) return '+' + d;
  return null;
};

async function build(session) {
  const [u, f] = await Promise.all([api(session, '/users'), api(session, '/callflows')]);
  if (!u.ok) throw new Error(`users: HTTP ${u.status}`);
  const users = Array.isArray(u.body?.data) ? u.body.data : [];
  const flows = f.ok && Array.isArray(f.body?.data) ? f.body.data : [];

  const nums = new Map();                         // user id -> { exts, dids }
  const codes = {};                               // feature name -> dialled code
  for (const cf of flows) {
    const fc = cf.featurecode;
    if (fc?.name && fc.number && !/^NA$/i.test(fc.name)) codes[fc.name] = '*' + String(fc.number).replace(/^\*/, '');
    const uid = cf.owner_id || cf.user_id;
    if (!uid) continue;
    if (!nums.has(uid)) nums.set(uid, { exts: [], dids: [] });
    const rec = nums.get(uid);
    for (const n of cf.numbers ?? []) {
      if (EXT.test(n)) rec.exts.push(n);
      else if (e164(n)) rec.dids.push(e164(n));
    }
  }

  const members = [];
  for (const x of users) {
    if (x.contact_list?.exclude === true) continue;
    const rec = nums.get(x.id) ?? { exts: [], dids: [] };
    const internal = String(x.caller_id?.internal?.number ?? '');
    const ext = rec.exts.sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
      || (EXT.test(internal) ? internal : '');
    const number = rec.dids[0] || e164(x.caller_id?.external?.number) || '';
    if (!ext && !number) continue;               // nothing to dial
    const name = [x.first_name, x.last_name].map(s => String(s ?? '').trim()).filter(Boolean).join(' ')
      || String(x.username ?? '').trim() || (ext ? 'Ext. ' + ext : number);
    members.push({ id: x.id, name, ext, number, email: String(x.email ?? ''), me: x.id === session.owner_id });
  }
  members.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    members,
    park: codes.park_and_retrieve ?? codes.park ?? null,
    retrieve: codes.retrieve ?? codes.park_and_retrieve ?? null,
  };
}

// The directory changes rarely: cached for ten minutes, refreshed behind the scenes.
export function company(session) {
  return swr(`company:${session.account_id}`, 10 * 60e3, () => build(session));
}

// Occupied park slots. Kazoo keeps the parked caller's ID on each slot.
export async function parked(session) {
  const r = await api(session, '/parked_calls');
  if (!r.ok) throw new Error(`parked calls: HTTP ${r.status}`);
  const slots = r.body?.data?.slots ?? {};
  return Object.entries(slots).map(([slot, s]) => ({
    slot,
    name: String(s?.['CID-Name'] ?? s?.caller_id_name ?? '').trim(),
    number: String(s?.['CID-Number'] ?? s?.caller_id_number ?? '').trim(),
  })).sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }));
}
