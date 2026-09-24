import { loadSession, api } from './lib/kazoo.mjs';
const s = loadSession();

console.log('=== /websockets (blackhole real-time) ===');
const ws = await api(s, '/websockets');
console.log(' ', ws.status, JSON.stringify(ws.body?.data ?? ws.body).slice(0, 600));

console.log('\n=== what does /messaging want? ===');
for (const p of ['/messaging', '/messaging?paginate=false']) {
  const r = await api(s, p);
  console.log(` ${r.status} ${p}`);
  console.log('   ', JSON.stringify(r.body?.data ?? r.body).slice(0, 500));
}

console.log('\n=== my user doc (messaging-relevant fields) ===');
const me = await api(s, `/users/${s.owner_id}`);
const d = me.body?.data ?? {};
for (const k of Object.keys(d).sort())
  if (/sms|mms|message|caller_id|presence|username|email|priv|number/i.test(k))
    console.log(`   ${k}:`, JSON.stringify(d[k]).slice(0, 160));

console.log('\n=== account doc (messaging flags) ===');
const acct = await api(s, '');
const a = acct.body?.data ?? {};
for (const k of Object.keys(a).sort())
  if (/sms|mms|message|realm|app|zone/i.test(k))
    console.log(`   ${k}:`, JSON.stringify(a[k]).slice(0, 200));
