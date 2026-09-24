import { loadSession, api } from '../lib/kazoo.mjs';
import { fetchMedia, describeImage } from '../lib/media.mjs';
const s = loadSession();
const me = (await api(s, `/users/${s.owner_id}`)).body.data;
const all = (await api(s, `/messaging?localNumber=${encodeURIComponent(me.phone_number)}`)).body.data ?? [];
const item = all.find(x => x.media?.length).media[0];

const full = await fetchMedia(s, item, me.phone_number);
const thumb = await fetchMedia(s, item, me.phone_number, { thumbnail: true });
console.log(`full : ${full.buf.length} bytes`);
console.log(`thumb: ${thumb ? thumb.buf.length + ' bytes ' + thumb.mime : 'NOT AVAILABLE'}\n`);
if (!thumb) process.exit(0);

for (const [label, img] of [['thumb', thumb], ['full', full]]) {
  const t = Date.now();
  const d = await describeImage(img, { model: 'google/gemma-4-e4b' });
  console.log(`--- e4b / ${label} [${Date.now() - t}ms] ---\n  ${d}\n`);
}
