import { loadSession, api } from './lib/kazoo.mjs';
const s = loadSession();

const me = (await api(s, `/users/${s.owner_id}`)).body.data;
const num = me.phone_number;
const R = (v) => {
  const j = JSON.stringify(v);
  return j ? j.replace(/\+?1?\d{10,}/g, '<NUM>').slice(0, 220) : j;
};

console.log('local number:', num.replace(/\d(?=\d{4})/g, '•'));

for (const p of [
  `/messaging?localNumber=${encodeURIComponent(num)}`,
  `/messaging?localNumber=${encodeURIComponent(num)}&paginate=false`,
]) {
  const r = await api(s, p);
  console.log(`\n${r.status} ${p.split('?')[0]}  (${p.includes('paginate') ? 'paginate=false' : 'default'})`);
  const d = r.body?.data;
  if (Array.isArray(d)) {
    console.log('  array of', d.length);
    if (d[0]) {
      console.log('  item keys:', Object.keys(d[0]).join(', '));
      console.log('  sample   :', R(d[0]));
    }
  } else if (d && typeof d === 'object') {
    console.log('  object keys:', Object.keys(d).join(', '));
    console.log('  sample     :', R(d));
  } else console.log('  ', R(r.body));
}
