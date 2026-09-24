import { loadSession, api } from './lib/kazoo.mjs';
const s = loadSession();
const me = (await api(s, `/users/${s.owner_id}`)).body.data;
console.log('my presence_id/ext:', me.presence_id, '| owner_id:', s.owner_id);

const r = await api(s, '/websockets');
console.log('\nactive tenant websocket sessions:', (r.body?.data ?? []).length);
for (const [i, sess] of (r.body?.data ?? []).entries()) {
  const msg = (sess.bindings ?? []).filter(b => b.startsWith('oomamsg.'));
  const mwi = (sess.bindings ?? []).filter(b => b.startsWith('ooma_mwi.'));
  const mine = mwi.some(b => b.endsWith('.' + me.presence_id));
  console.log(`  [${i}] ${mine ? 'MINE ' : 'other'}  mwi=${mwi.join(',') || '-'}  boxes=${msg.length}`);
}

// Does a box id appear anywhere tied to me?
const msgs = (await api(s, `/messaging?localNumber=${encodeURIComponent(me.phone_number)}`)).body.data ?? [];
console.log('\nmy messages:', msgs.length);
if (msgs[0]) {
  const ids = new Set();
  for (const m of msgs) for (const k of ['from','notify','src_id','owner_id']) if (m[k]) ids.add(`${k}=${JSON.stringify(m[k]).slice(0,90)}`);
  for (const v of [...ids].slice(0, 8)) console.log('   ', v);
}
