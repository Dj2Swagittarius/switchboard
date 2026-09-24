import { loadSession, api } from './lib/kazoo.mjs';
const s = loadSession();
const me = (await api(s, `/users/${s.owner_id}`)).body.data;
const all = (await api(s, `/messaging?localNumber=${encodeURIComponent(me.phone_number)}`)).body.data ?? [];
const tally = (k) => {
  const c = {};
  for (const m of all) c[JSON.stringify(m[k])] = (c[JSON.stringify(m[k])] ?? 0) + 1;
  return c;
};
for (const k of ['direction', 'state', 'sender', 'notify', 'deleted']) console.log(k.padEnd(10), tally(k));
console.log('\nhas value/body:', all.filter(m => m.value).length, 'of', all.length);
const m = all[0];
console.log('\nfull first record (numbers masked, body truncated):');
const red = { ...m };
for (const k of ['remoteNumber','localNumber','from']) if (red[k]) red[k] = String(red[k]).replace(/\d(?=\d{4})/g,'•');
if (red.value) red.value = String(red.value).slice(0, 60) + '…';
console.log(JSON.stringify(red, null, 2).slice(0, 1200));
