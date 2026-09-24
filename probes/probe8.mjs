import { loadSession, api } from '../lib/kazoo.mjs';
const s = loadSession();
const me = (await api(s, `/users/${s.owner_id}`)).body.data;
const all = (await api(s, `/messaging?localNumber=${encodeURIComponent(me.phone_number)}`)).body.data ?? [];
const withMedia = all.find(m => m.media?.length);
const item = withMedia.media[0];

console.log('media item keys:', Object.keys(item).join(', '));
console.log('ooma_media_url :', item.ooma_media_url);
console.log('mime / size    :', item.media?.mime_type, item.media?.size);
console.log('thumbnail?     :', typeof item.thumbnail, JSON.stringify(item.thumbnail).slice(0,120));

const base = item.ooma_media_url + '/raw';
const qs = `localNumber=${encodeURIComponent(me.phone_number)}`;

console.log('\n-- A: header auth (preferred, no token in URL) --');
let r = await fetch(`${base}?${qs}`, { headers: { 'X-Auth-Token': s.auth_token } });
console.log('  ', r.status, r.headers.get('content-type'), r.headers.get('content-length'));

console.log('-- B: query-param auth (fallback) --');
r = await fetch(`${base}?${qs}&auth_token=${s.auth_token}`);
console.log('  ', r.status, r.headers.get('content-type'), r.headers.get('content-length'));
if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); console.log('   bytes:', b.length, 'magic:', b.subarray(0,3).toString('hex')); }
