import { loadSession, api } from './lib/kazoo.mjs';
const s = loadSession();
const num = (await api(s, `/users/${s.owner_id}`)).body.data.phone_number;
const q = `localNumber=${encodeURIComponent(num)}`;

console.log('=== allowed methods on /messaging ===');
const o = await api(s, `/messaging?${q}`, { method: 'OPTIONS' });
console.log(' ', o.status, JSON.stringify(o.body).slice(0, 300));

console.log('\n=== send shape (EMPTY body — nothing can send, missing required fields) ===');
for (const m of ['POST', 'PUT']) {
  const r = await api(s, `/messaging?${q}`, { method: m, body: JSON.stringify({ data: {} }) });
  console.log(` ${m} ${r.status}:`, JSON.stringify(r.body?.data ?? r.body).slice(0, 400));
}

console.log('\n=== box / conversation subpaths ===');
for (const p of ['/messaging/boxes', '/messaging/box', '/messaging/conversations',
                 `/messaging/boxes?${q}`, `/messaging/conversations?${q}`, `/messaging/threads?${q}`]) {
  const r = await api(s, p);
  const d = r.body?.data;
  console.log(` ${String(r.status).padEnd(4)} ${p.split('?')[0].padEnd(26)} ${Array.isArray(d) ? d.length + ' item(s)' : (r.body?.message ?? 'ok')}`);
  if (Array.isArray(d) && d[0]) console.log('        keys:', Object.keys(d[0]).join(', '));
}
